import { createHash } from "node:crypto";
import {
  type WhatsAppConnectInput,
  type WhatsAppRule,
  type WhatsAppTemplate,
  whatsappDeliveriesSchema,
  whatsappDeskSchema,
  whatsappKindSchema,
  whatsappRuleSchema,
  whatsappTemplateSchema,
} from "@sob/contracts";
import { type Database, reminder, syncChange, whatsappConnection } from "@sob/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { backfillWhatsAppReminders } from "../outbox";
import { createMeta, tokenCipher } from "./meta";

const savedRule = whatsappRuleSchema.extend({ template: whatsappTemplateSchema });
const savedRules = z.array(savedRule);
type SavedRule = z.infer<typeof savedRule>;

export async function readConnection(db: Pick<Database, "select">, lock?: "share" | "update") {
  const query = db.select().from(whatsappConnection).where(eq(whatsappConnection.id, 1));
  const [connection] = await (lock ? query.for(lock) : query);
  return connection;
}

type ConnectedSender = NonNullable<Awaited<ReturnType<typeof readConnection>>>;

function senderRevision(connection: ConnectedSender) {
  return createHash("sha256")
    .update(JSON.stringify([connection.encryptedToken, connection.rules]))
    .digest("hex");
}

export function activeRules(connection: Awaited<ReturnType<typeof readConnection>>, now: Date) {
  if (!connection || (connection.expiresAt && connection.expiresAt <= now)) return [];
  return savedRules.parse(connection.rules);
}

export function requestToken(
  config: NotificationConfig,
  connection: NonNullable<Awaited<ReturnType<typeof readConnection>>>,
) {
  return tokenCipher(config.signingSecret, connection.phoneId).open(connection.encryptedToken);
}

export function whatsappSettings(
  config: NotificationConfig,
  connection: Awaited<ReturnType<typeof readConnection>>,
) {
  const meta = config.whatsapp;
  return {
    setup: meta ? { appId: meta.appId, configId: meta.configId, version: meta.version } : null,
    connection: connection
      ? {
          phone: connection.phone,
          revision: senderRevision(connection),
          coexistence: connection.coexistence,
          rules: savedRules
            .parse(connection.rules)
            .map(({ kind, templateId, variables }) => ({ kind, templateId, variables })),
          expiresAt: connection.expiresAt?.toISOString() ?? null,
        }
      : null,
  };
}

export async function listDeliveries(db: Pick<Database, "select">) {
  const rows = await db
    .select({
      id: reminder.id,
      kind: reminder.kind,
      scheduledFor: reminder.scheduledFor,
      status: reminder.status,
      delivery: reminder.whatsappDelivery,
      lastError: reminder.lastError,
    })
    .from(reminder)
    .where(
      and(
        eq(reminder.channel, "whatsapp"),
        // These jobs never went to Meta. A batch disconnect must not bury delivery history.
        sql`${reminder.lastError} is distinct from 'whatsapp_disconnected'`,
      ),
    )
    .orderBy(desc(reminder.updatedAt), desc(reminder.id))
    .limit(20);
  return whatsappDeliveriesSchema.parse(
    rows.map((row) => ({ ...row, scheduledFor: row.scheduledFor.toISOString() })),
  );
}

export async function whatsappDesk(db: Database, config: NotificationConfig) {
  const [connection, deliveries] = await Promise.all([readConnection(db), listDeliveries(db)]);
  return whatsappDeskSchema.parse({
    configured: Boolean(config.whatsapp),
    connection: connection
      ? {
          phone: connection.phone,
          revision: senderRevision(connection),
          coexistence: connection.coexistence,
          expiresAt: connection.expiresAt?.toISOString() ?? null,
          rules: savedRules
            .parse(connection.rules)
            .map(({ kind, templateId, variables, template }) => ({
              kind,
              templateId,
              variables,
              templateName: template.name,
              language: template.language,
            })),
        }
      : null,
    deliveries: deliveries.map(({ lastError, ...delivery }) => ({
      ...delivery,
      uncertain: !delivery.delivery && lastError === "whatsapp_delivery_unknown",
    })),
  });
}

export async function updateWhatsAppRules(
  db: Database,
  config: NotificationConfig,
  rules: WhatsAppRule[],
  now: Date,
  request?: typeof fetch,
  reviewedRevision?: string,
) {
  const connection = await readConnection(db);
  if (!connection)
    throw new DomainError("invalid_state", "Conecte un número para guardar automatizaciones.");
  const loadedRevision = senderRevision(connection);
  const changed = () =>
    new DomainError(
      "version_conflict",
      "Las automatizaciones cambiaron. Cargue los ajustes actuales.",
    );
  if (reviewedRevision && reviewedRevision !== loadedRevision) throw changed();
  const mapped = rules.length
    ? mapRules(rules, await listTemplates(config, connection, request))
    : [];
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtext('citame.whatsapp.connection'))`,
    );
    await lockScheduling(tx);
    const current = await readConnection(tx, "update");
    if (!current || senderRevision(current) !== loadedRevision) throw changed();
    const [updated] = await tx
      .update(whatsappConnection)
      .set({ rules: mapped })
      .where(eq(whatsappConnection.id, 1))
      .returning();
    if (!updated) throw changed();
    const enabled = new Set(rules.map(({ kind }) => kind));
    const disabled = whatsappKindSchema.options.filter((kind) => !enabled.has(kind));
    if (disabled.length)
      await tx
        .update(reminder)
        .set({ status: "cancelled", lockedUntil: null, lastError: "whatsapp_rule_disabled" })
        .where(
          and(
            eq(reminder.channel, "whatsapp"),
            inArray(reminder.kind, disabled),
            inArray(reminder.status, ["pending", "processing"]),
            isNull(reminder.whatsappDispatchAt),
          ),
        );
    await backfillWhatsAppReminders(tx, now, enabled);
    return updated;
  });
}

async function lockWhatsAppConnection(tx: Tx) {
  const [lock] = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(hashtext('citame.whatsapp.connection')) as locked`,
  );
  if (!lock?.locked) throw new DomainError("invalid_state", "Ya hay una conexión en curso.");
}

// Compaction retains the latest entry per topic. Its position distinguishes disconnected periods.
async function disconnectedRevision(db: Pick<Database, "select">, generation: string) {
  const [entry] = await db
    .select({ seq: syncChange.seq })
    .from(syncChange)
    .where(and(eq(syncChange.entity, "live_view"), eq(syncChange.rowId, "whatsapp_settings")))
    .orderBy(desc(syncChange.seq))
    .limit(1);
  return createHash("sha256")
    .update(`disconnected:${generation}:${entry?.seq ?? 0}`)
    .digest("hex");
}

export async function readWhatsappSettings(
  db: Database,
  config: NotificationConfig,
  generation: string,
) {
  const connection = await readConnection(db);
  return {
    ...whatsappSettings(config, connection),
    ...(!connection && config.whatsapp
      ? { signupRevision: await disconnectedRevision(db, generation) }
      : {}),
  };
}

export async function connectWhatsApp(
  db: Database,
  notifications: NotificationConfig,
  input: WhatsAppConnectInput,
  now: () => Date,
  request: typeof fetch | undefined,
  review?: { revision: string; generation: string },
) {
  const settings = notifications.whatsapp;
  if (!settings) throw new DomainError("invalid_state", "Meta WhatsApp no está configurado.");
  if (!notifications.publicUrl.startsWith("https://"))
    throw new DomainError("invalid_state", "La conexión necesita una URL pública HTTPS.");
  const meta = createMeta(settings, request);
  try {
    return await db.transaction(async (tx) => {
      await lockWhatsAppConnection(tx);
      const current = await readConnection(tx);
      if (
        review &&
        review.revision !==
          (current ? senderRevision(current) : await disconnectedRevision(tx, review.generation))
      )
        throw new DomainError(
          "version_conflict",
          "The WhatsApp connection changed. Start a new signup to continue.",
        );
      const grant = await meta.exchange(input.code);
      const phones = await meta.phones(input.wabaId, grant.access_token);
      const selected = input.phoneId
        ? phones.find((phone) => phone.id === input.phoneId)
        : phones.length === 1
          ? phones[0]
          : undefined;
      if (!selected)
        throw new DomainError(
          "validation_error",
          "Seleccione un único número de la cuenta autorizada en Meta.",
        );
      if (current && (current.wabaId !== input.wabaId || current.phoneId !== selected.id))
        throw new DomainError(
          "invalid_state",
          "Seleccione el número conectado o desconéctelo de Citame antes de cambiarlo.",
        );
      const coexistence = selected.is_on_biz_app === true;
      if (
        !current &&
        !coexistence &&
        !(selected.platform_type === "CLOUD_API" && selected.status === "CONNECTED")
      ) {
        if (!input.pin)
          throw new DomainError(
            "validation_error",
            "El número nuevo necesita un PIN de verificación de seis cifras.",
          );
        await meta.register(selected.id, grant.access_token, input.pin);
      }
      await meta.subscribe(
        input.wabaId,
        grant.access_token,
        `${notifications.publicUrl}/api/whatsapp/webhook`,
      );
      const sender = {
        phone: selected.display_phone_number,
        coexistence,
        encryptedToken: tokenCipher(notifications.signingSecret, selected.id).seal(
          grant.access_token,
        ),
        expiresAt: grant.expires_in ? new Date(now().getTime() + grant.expires_in * 1000) : null,
      };
      const [saved] = await tx
        .insert(whatsappConnection)
        .values({
          wabaId: input.wabaId,
          phoneId: selected.id,
          ...sender,
        })
        .onConflictDoUpdate({ target: whatsappConnection.id, set: sender })
        .returning();
      if (!saved) throw new Error("Could not persist WhatsApp connection");
      return saved;
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "invalid_state",
      "Meta no pudo conectar el número. Compruebe los permisos y vuelva a iniciar la conexión.",
    );
  }
}

export async function disconnectWhatsApp(
  db: Database,
  review?: { revision: string; signupGeneration?: string },
) {
  return db.transaction(async (tx) => {
    await lockWhatsAppConnection(tx);
    await lockScheduling(tx);
    const current = await readConnection(tx, "update");
    if (current && review && senderRevision(current) !== review.revision)
      throw new DomainError(
        "version_conflict",
        "The WhatsApp connection changed. Review the current number before disconnecting.",
      );
    if (current) await disableWhatsApp(tx);
    if (review?.signupGeneration === undefined) return undefined;
    // Publish this disconnect's marker before calculating its revision inside the lock.
    if (current) await tx.execute(sql`set constraints sync_whatsapp_settings_live_view immediate`);
    return disconnectedRevision(tx, review.signupGeneration);
  });
}

export async function disableWhatsApp(db: Pick<Database, "delete" | "update">) {
  const rows = await db
    .delete(whatsappConnection)
    .where(eq(whatsappConnection.id, 1))
    .returning({ id: whatsappConnection.id });
  if (rows.length)
    await db
      .update(reminder)
      .set({ status: "cancelled", lockedUntil: null, lastError: "whatsapp_disconnected" })
      .where(
        and(
          eq(reminder.channel, "whatsapp"),
          inArray(reminder.status, ["pending", "processing"]),
          isNull(reminder.whatsappDispatchAt),
        ),
      );
}

export function mapRules(rules: WhatsAppRule[], templates: WhatsAppTemplate[]): SavedRule[] {
  return rules.map((rule) => {
    const template = templates.find((item) => item.id === rule.templateId);
    if (!template || template.parameters.length !== rule.variables.length)
      throw new DomainError(
        "validation_error",
        "Seleccione una plantilla de utilidad aprobada y asigne todas sus variables.",
      );
    return { ...rule, template };
  });
}

export function buildTemplateMessage(
  rule: SavedRule,
  to: string,
  notificationId: string,
  values: Record<WhatsAppRule["variables"][number], string>,
) {
  const { template, variables } = rule;
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: to.slice(1),
    type: "template",
    biz_opaque_callback_data: notificationId,
    template: {
      name: template.name,
      language: { code: template.language },
      ...(variables.length
        ? {
            components: [
              {
                type: "body",
                parameters: variables.map((variable, i) => ({
                  type: "text",
                  text: values[variable].replace(/\s+/g, " ").trim() || "—",
                  ...(template.named ? { parameter_name: template.parameters[i] } : {}),
                })),
              },
            ],
          }
        : {}),
    },
  };
}

export async function listTemplates(
  config: NotificationConfig,
  connection: NonNullable<Awaited<ReturnType<typeof readConnection>>>,
  request?: typeof fetch,
) {
  if (!config.whatsapp)
    throw new DomainError("invalid_state", "Meta WhatsApp no está configurado.");
  try {
    return await createMeta(config.whatsapp, request).templates(
      connection.wabaId,
      requestToken(config, connection),
    );
  } catch {
    throw new DomainError(
      "invalid_state",
      "No se pudieron consultar las plantillas. Compruebe la conexión en Meta.",
    );
  }
}
