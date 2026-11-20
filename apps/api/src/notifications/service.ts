import type {
  NotificationPreferences,
  OptOutPreview,
  UpdateNotificationPreferencesRequest,
} from "@sob/contracts";
import { clientProfile, type Database, notificationPreference, reminder } from "@sob/db";
import { and, count, eq, sql } from "drizzle-orm";
import { recordAudit } from "../audit";
import { clientRoot, lockClientRoot } from "../client-identity";
import { DomainError } from "../errors";
import { type Channel, effectivePreference, phoneHash } from "./preferences";
import { type OptOutClaims, verifyOptOutToken } from "./tokens";

async function loadClient(db: Pick<Database, "select">, clientId: string) {
  return clientRoot(db, clientId);
}

export async function getPreferences(
  db: Pick<Database, "select">,
  clientId: string,
): Promise<NotificationPreferences> {
  const client = await loadClient(db, clientId);
  const rows = await db
    .select()
    .from(notificationPreference)
    .where(
      sql`${notificationPreference.clientId} in(select client_identity_ids(${client.id}::uuid))`,
    );
  const pick = (channel: Channel) => ({
    transactional: effectivePreference(rows, client.id, channel, "transactional", client.phone),
    reminder: effectivePreference(rows, client.id, channel, "reminder", client.phone),
  });
  const locale = client.locale === "en" || client.locale === "es-AR" ? client.locale : null;
  return {
    locale,
    email: pick("email"),
    sms: pick("sms"),
    whatsapp: pick("whatsapp"),
    hasWhatsAppPhone: Boolean(phoneHash(client.phone)),
    hasEmail: Boolean(client.email),
    hasPhone: Boolean(client.phone),
  };
}

async function setPreference(
  db: Pick<Database, "insert">,
  clientId: string,
  channel: Channel,
  category: "transactional" | "reminder",
  enabled: boolean,
  destinationHash: string | null = null,
) {
  await db
    .insert(notificationPreference)
    .values({ clientId, channel, category, enabled, destinationHash })
    .onConflictDoUpdate({
      target: [
        notificationPreference.clientId,
        notificationPreference.channel,
        notificationPreference.category,
      ],
      set: { enabled, destinationHash, updatedAt: new Date() },
    });
}

export async function updatePreferences(
  db: Database,
  clientId: string,
  userId: string,
  request: UpdateNotificationPreferencesRequest,
): Promise<NotificationPreferences> {
  await db.transaction(async (tx) => {
    const client = await lockClientRoot(tx, clientId);
    if (client.id !== clientId)
      throw new DomainError(
        "client_merged",
        "Open the current profile before changing preferences",
      );
    if (request.locale !== undefined) {
      await tx
        .update(clientProfile)
        .set({ locale: request.locale })
        .where(eq(clientProfile.id, clientId));
    }
    for (const channel of ["email", "sms", "whatsapp"] as const) {
      for (const category of ["transactional", "reminder"] as const) {
        const value = request[channel]?.[category];
        if (value !== undefined) {
          // A fresh authenticated choice supersedes the group's earlier channel choices.
          await tx
            .update(notificationPreference)
            .set({ enabled: value, updatedAt: new Date() })
            .where(
              and(
                sql`${notificationPreference.clientId} in(select client_identity_ids(${client.id}::uuid))`,
                eq(notificationPreference.channel, channel),
                eq(notificationPreference.category, category),
              ),
            );
          const destination = channel === "whatsapp" && value ? phoneHash(client.phone) : null;
          if (channel === "whatsapp" && value && !destination)
            throw new DomainError(
              "validation_error",
              "A phone number with country code is required for WhatsApp",
            );
          await setPreference(tx, clientId, channel, category, value, destination);
        }
      }
    }
    await recordAudit(tx, {
      actorUserId: userId,
      action: "notifications.preferences",
      entity: "client_profile",
      entityId: clientId,
      // Which switches changed, never contact details.
      metadata: { fields: Object.keys(request) },
    });
  });
  return getPreferences(db, clientId);
}

function claimsOrThrow(secret: string, token: string): OptOutClaims {
  const claims = verifyOptOutToken(secret, token);
  if (!claims) throw new DomainError("validation_error", "This unsubscribe link is not valid");
  return claims;
}

export async function previewOptOut(
  db: Database,
  secret: string,
  token: string,
): Promise<OptOutPreview> {
  const claims = claimsOrThrow(secret, token);
  await loadClient(db, claims.clientId).catch(() => {
    throw new DomainError("validation_error", "This unsubscribe link is not valid");
  });
  const prefs = await getPreferences(db, claims.clientId);
  return {
    channel: claims.channel,
    category: "reminder",
    optedOut: !prefs[claims.channel]?.reminder,
  };
}

/** Switches reminders off for one channel. Idempotent; never touches transactional messages. */
export async function applyOptOut(
  db: Database,
  secret: string,
  token: string,
): Promise<OptOutPreview> {
  const claims = claimsOrThrow(secret, token);
  await db.transaction(async (tx) => {
    const client = await lockClientRoot(tx, claims.clientId).catch(() => {
      throw new DomainError("validation_error", "This unsubscribe link is not valid");
    });
    await setPreference(tx, client.id, claims.channel, "reminder", false);
    await recordAudit(tx, {
      actorUserId: null,
      action: "notifications.opt_out",
      entity: "client_profile",
      entityId: claims.clientId,
      metadata: { channel: claims.channel, category: "reminder" },
    });
  });
  return { channel: claims.channel, category: "reminder", optedOut: true };
}

/** Queue depth by status: what an operator needs to see that the pipeline is moving. */
export async function queueStats(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ status: reminder.status, n: count() })
    .from(reminder)
    .groupBy(reminder.status);
  const stats: Record<string, number> = {
    pending: 0,
    processing: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  for (const row of rows) stats[row.status] = row.n;
  const [overdue] = await db
    .select({ n: count() })
    .from(reminder)
    .where(
      and(
        eq(reminder.status, "pending"),
        sql`${reminder.scheduledFor} < now() - interval '5 minutes'`,
      ),
    );
  stats.overdue = overdue?.n ?? 0;
  return stats;
}
