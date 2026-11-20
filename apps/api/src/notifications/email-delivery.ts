import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  type EmailDeliveryInput,
  type EmailDeliveryProvider,
  type EmailDeliverySettings,
  emailDeliveryProviderSchema,
} from "@sob/contracts";
import { type Database, emailDelivery } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit";
import type { NotificationConfig } from "../config";
import { DomainError } from "../errors";
import type { Tx } from "../tx";
import { resolvePublicSmtp } from "./providers/public-smtp";
import { createResendProvider } from "./providers/resend";
import { createSmtpProvider } from "./providers/smtp";
import { type EmailProvider, PermanentProviderError } from "./providers/types";

const active = (settings: EmailDeliveryProvider) => "fromEmail" in settings;
type Row = typeof emailDelivery.$inferSelect;

async function read(db: Database | Tx) {
  const [row] = await db.select().from(emailDelivery).where(eq(emailDelivery.id, 1));
  return row;
}

function settingsFor(row?: Row): EmailDeliveryProvider {
  return row ? emailDeliveryProviderSchema.parse(row.settings) : { provider: "inherit" };
}

function view(row: Row | undefined, config: NotificationConfig): EmailDeliverySettings {
  return {
    revision: row?.revision ?? null,
    settings: settingsFor(row),
    serverEmailEnabled: config.email.provider !== "none",
    hasSecret: Boolean(row?.encryptedSecret),
  };
}

export async function getEmailDelivery(db: Database, config: NotificationConfig) {
  return view(await read(db), config);
}

function identity(settings: EmailDeliveryProvider) {
  if (settings.provider === "smtp")
    return JSON.stringify([
      settings.provider,
      settings.host,
      settings.port,
      settings.encryption,
      settings.username,
    ]);
  if (settings.provider === "gmail") return JSON.stringify([settings.provider, settings.fromEmail]);
  return settings.provider;
}

function secretKey(secret: string) {
  return createHash("sha256").update("citame-notification-email-v1\0").update(secret).digest();
}

function seal(value: string, secret: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", secretKey(secret), iv).setAAD(Buffer.from(context));
  return Buffer.concat([
    iv,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
}

function open(value: string, secret: string, context: string) {
  const bytes = Buffer.from(value, "base64url");
  const cipher = createDecipheriv("aes-256-gcm", secretKey(secret), bytes.subarray(0, 12)).setAAD(
    Buffer.from(context),
  );
  cipher.setAuthTag(bytes.subarray(-16));
  return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString("utf8");
}

export async function updateEmailDelivery(
  db: Database,
  config: NotificationConfig,
  actorUserId: string,
  input: EmailDeliveryInput,
) {
  const { settings } = input;
  if (settings.provider === "smtp") {
    try {
      await resolvePublicSmtp(settings.host);
    } catch {
      throw new DomainError("validation_error", "Use a public, reachable SMTP hostname");
    }
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('citame.email-delivery'))`);
    const previous = await read(tx);
    if ((previous?.revision ?? null) !== input.revision)
      throw new DomainError("version_conflict", "Email settings changed; reload before saving");
    const context = identity(settings);
    let encryptedSecret: string | null = null;
    if (active(settings)) {
      if (input.secret) {
        const value = settings.provider === "gmail" ? input.secret.replace(/ /g, "") : input.secret;
        if (settings.provider === "gmail" && !/^[a-zA-Z0-9]{16}$/.test(value))
          throw new DomainError("validation_error", "Use a 16-character Google app password");
        if (settings.provider === "resend" && !/^re_[A-Za-z0-9_-]+$/.test(value))
          throw new DomainError("validation_error", "Use a Resend API key");
        encryptedSecret = seal(value, config.signingSecret, context);
      } else if (previous && identity(settingsFor(previous)) === context) {
        encryptedSecret = previous.encryptedSecret;
      }
      if (!encryptedSecret)
        throw new DomainError("validation_error", "Enter the provider credential");
    } else if (input.secret)
      throw new DomainError("validation_error", "This mode uses no credential");
    const change = {
      revision: Bun.randomUUIDv7(),
      settings,
      encryptedSecret,
      updatedAt: new Date(),
    };
    const [saved] = await tx
      .insert(emailDelivery)
      .values(change)
      .onConflictDoUpdate({ target: emailDelivery.id, set: change })
      .returning();
    if (!saved) throw new Error("Email settings write returned no row");
    await recordAudit(tx, {
      actorUserId,
      action: "notification.email_settings_updated",
      entity: "email_delivery",
      metadata: { provider: settings.provider },
    });
    return view(saved, config);
  });
}

export async function resolveNotificationEmail(
  db: Database,
  config: NotificationConfig,
  fallback: EmailProvider | null,
  request?: typeof fetch,
): Promise<EmailProvider | null> {
  const row = await read(db);
  const settings = settingsFor(row);
  if (settings.provider === "inherit") return fallback;
  if (settings.provider === "disabled") return null;
  return {
    async send(message) {
      let credential: string;
      try {
        if (!row?.encryptedSecret) throw new Error("missing");
        credential = open(row.encryptedSecret, config.signingSecret, identity(settings));
      } catch {
        throw new PermanentProviderError("email_credentials_unreadable");
      }
      // The contract excludes angle brackets and controls. Quote for SMTP and Resend alike.
      const from = `"${settings.fromName.replace(/[\\"]/g, "\\$&")}" <${settings.fromEmail}>`;
      if (settings.provider === "resend")
        return createResendProvider(from, credential, request).send(message);
      const servername = settings.provider === "gmail" ? "smtp.gmail.com" : settings.host;
      const host = await resolvePublicSmtp(servername);
      const implicitTLS = settings.provider === "gmail" || settings.encryption === "tls";
      const provider = createSmtpProvider({
        from,
        connection: {
          host,
          port: settings.provider === "gmail" ? 465 : settings.port,
          secure: implicitTLS,
          requireTLS: !implicitTLS,
          tls: { servername, rejectUnauthorized: true, minVersion: "TLSv1.2" },
          auth: {
            user: settings.provider === "gmail" ? settings.fromEmail : settings.username,
            pass: credential,
          },
        },
      });
      try {
        return await provider.send(message);
      } finally {
        await provider.close?.();
      }
    },
  };
}
