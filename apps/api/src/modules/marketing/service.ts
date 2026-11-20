import { createHash } from "node:crypto";
import {
  type Campaign,
  type CampaignCreate,
  type CampaignQuery,
  type CampaignQueue,
  type CampaignUpdate,
  campaignSchema,
} from "@sob/contracts";
import {
  auditLog,
  clientProfile,
  type Database,
  marketingCampaign,
  marketingDelivery,
} from "@sob/db";
import { and, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import type { NotificationConfig } from "../../config";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { campaignAudience, marketingCapabilities } from "./audience";

type Connection = Database | Tx;
export type CampaignRow = typeof marketingCampaign.$inferSelect;
export const emptyCampaignCounts = () => ({
  pending: 0,
  processing: 0,
  sent: 0,
  skipped: 0,
  failed: 0,
  unknown: 0,
  cancelled: 0,
});
export async function campaignRow(db: Connection, id: string, lock = false) {
  const query = db
    .select()
    .from(marketingCampaign)
    .where(and(eq(marketingCampaign.id, id), eq(marketingCampaign.purpose, "campaign")));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Campaign not found");
  return row;
}
export async function campaignViews(db: Connection, rows: CampaignRow[]): Promise<Campaign[]> {
  const counts = rows.length
    ? await db
        .select({
          campaignId: marketingDelivery.campaignId,
          status: marketingDelivery.status,
          n: count(),
        })
        .from(marketingDelivery)
        .where(
          inArray(
            marketingDelivery.campaignId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(marketingDelivery.campaignId, marketingDelivery.status)
    : [];
  const totals = new Map(rows.map((row) => [row.id, emptyCampaignCounts()]));
  for (const row of counts) {
    const target = totals.get(row.campaignId);
    if (target) target[row.status] = row.n;
  }
  return rows.map((row) => {
    const { createdBy: _, requestDigest: __, evaluatedAt: ___, purpose: ____, ...visible } = row;
    return campaignSchema.parse({
      ...visible,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      counts: totals.get(row.id),
    });
  });
}
export async function getCampaign(db: Database, id: string, p: Principal) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => (await campaignViews(tx, [await campaignRow(tx, id)]))[0]!, {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
export async function listCampaigns(db: Database, q: CampaignQuery, p: Principal) {
  requirePermission(p, "editCatalog");
  const term = q.search.replace(/[\\%_]/g, "\\$&");
  const where = and(
    eq(marketingCampaign.purpose, "campaign"),
    q.search ? ilike(marketingCampaign.name, `%${term}%`) : undefined,
    q.status ? eq(marketingCampaign.status, q.status) : undefined,
  );
  return db.transaction(
    async (tx) => {
      const [total] = await tx.select({ n: count() }).from(marketingCampaign).where(where);
      const rows = await tx
        .select()
        .from(marketingCampaign)
        .where(where)
        .orderBy(desc(marketingCampaign.createdAt), desc(marketingCampaign.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return {
        campaigns: await campaignViews(tx, rows),
        pagination: { page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function createCampaign(db: Database, input: CampaignCreate, p: Principal) {
  requirePermission(p, "editCatalog");
  const { id, ...fields } = input;
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`campaign-create:${id}`},0))`,
    );
    const [previous] = await tx
      .select()
      .from(marketingCampaign)
      .where(eq(marketingCampaign.id, id));
    if (previous) {
      if (previous.createdBy !== p.userId || previous.requestDigest !== digest)
        throw new DomainError("invalid_state", "Campaign request already used");
      return (await campaignViews(tx, [previous]))[0]!;
    }
    const [row] = await tx
      .insert(marketingCampaign)
      .values({ id, ...fields, createdBy: p.userId, requestDigest: digest })
      .returning();
    if (!row) throw Error("Campaign insert failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "marketing.campaign_created",
      entity: "marketing_campaign",
      entityId: id,
    });
    return (await campaignViews(tx, [row]))[0]!;
  });
}
export async function updateCampaign(
  db: Database,
  id: string,
  input: CampaignUpdate,
  p: Principal,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    const current = await campaignRow(tx, id, true);
    if (current.version !== input.version)
      throw new DomainError("version_conflict", "Campaign changed; reload before editing");
    if (current.status !== "draft")
      throw new DomainError(
        "invalid_state",
        "Only a draft can be edited; cancel or duplicate this campaign",
      );
    const { version, ...fields } = input;
    const [row] = await tx
      .update(marketingCampaign)
      .set({ ...fields, version: version + 1 })
      .where(eq(marketingCampaign.id, id))
      .returning();
    if (!row) throw Error("Campaign update failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "marketing.campaign_updated",
      entity: "marketing_campaign",
      entityId: id,
    });
    return (await campaignViews(tx, [row]))[0]!;
  });
}
function requireContent(row: CampaignRow) {
  if (
    (row.channel === "email" || row.channel === "optimized") &&
    (!row.subject.trim() || !row.emailBody.trim())
  )
    throw new DomainError("validation_error", "Email needs a subject and message");
  if ((row.channel === "sms" || row.channel === "optimized") && !row.smsBody.trim())
    throw new DomainError("validation_error", "SMS needs a message");
}
export async function previewCampaign(
  db: Database,
  id: string,
  p: Principal,
  config: NotificationConfig,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(
    async (tx) => {
      const row = await campaignRow(tx, id);
      requireContent(row);
      const audience = await campaignAudience(
        tx,
        { ...row, activatedAt: row.activatedAt ?? (row.trigger === "first_visit" ? now : null) },
        marketingCapabilities(config),
        now,
      );
      return {
        campaignId: row.id,
        version: row.version,
        audienceHash: audience.audienceHash,
        eligible: audience.recipients.length,
        email: audience.recipients.filter((row) => row.channel === "email").length,
        sms: audience.recipients.filter((row) => row.channel === "sms").length,
        excluded: audience.excluded,
        sample: audience.recipients
          .slice(0, 10)
          .map(({ clientId, name, channel }) => ({ clientId, name, channel })),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function queueCampaign(
  db: Database,
  id: string,
  input: CampaignQueue,
  p: Principal,
  config: NotificationConfig,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  const queueDigest = createHash("sha256")
    .update(
      JSON.stringify({
        version: input.version,
        audienceHash: input.audienceHash,
        scheduledFor: input.scheduledFor,
      }),
    )
    .digest("hex");
  const capabilities = marketingCapabilities(config);
  if (!capabilities.worker || (!capabilities.email && !capabilities.sms))
    throw new DomainError("invalid_state", "Campaign delivery is not configured");
  const scheduled = input.scheduledFor ? new Date(input.scheduledFor) : now;
  return db.transaction(async (tx) => {
    const row = await campaignRow(tx, id, true);
    // Replays bind both the reviewed audience and the chosen delivery time.
    if (
      row.version === input.version + 1 &&
      ["scheduled", "active", "completed"].includes(row.status)
    ) {
      const [event] = await tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entity, "marketing_campaign"),
            eq(auditLog.entityId, id),
            inArray(auditLog.action, [
              "marketing.campaign_scheduled",
              "marketing.automation_activated",
            ]),
          ),
        )
        .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
        .limit(1);
      if (event?.metadata.queueDigest !== queueDigest)
        throw new DomainError("invalid_state", "Delivery request changed; reload this campaign");
      return (await campaignViews(tx, [row]))[0]!;
    }
    if (
      scheduled.getTime() < now.getTime() - 60000 ||
      scheduled.getTime() > now.getTime() + 366 * 86400000
    )
      throw new DomainError("validation_error", "Choose a delivery date within the next year");
    if (row.version !== input.version)
      throw new DomainError("version_conflict", "Campaign changed; preview it again");
    if (row.status !== "draft")
      throw new DomainError("invalid_state", "This campaign is already queued");
    requireContent(row);
    if (
      (row.channel === "email" && !capabilities.email) ||
      (row.channel === "sms" && !capabilities.sms)
    )
      throw new DomainError("invalid_state", "The selected delivery channel is not configured");
    const audience = await campaignAudience(
      tx,
      { ...row, activatedAt: row.trigger === "first_visit" ? scheduled : null },
      capabilities,
      now,
    );
    if (audience.audienceHash !== input.audienceHash)
      throw new DomainError("version_conflict", "The audience changed; preview it again");
    if (row.trigger === "manual" && !audience.recipients.length)
      throw new DomainError(
        "validation_error",
        "No clients have permission and a configured delivery channel",
      );
    if (row.trigger === "manual") {
      for (let offset = 0; offset < audience.recipients.length; offset += 500)
        await tx
          .insert(marketingDelivery)
          .values(
            audience.recipients.slice(offset, offset + 500).map((recipient) => ({
              campaignId: id,
              clientId: recipient.clientId,
              channel: recipient.channel,
              occurrence: recipient.occurrence,
              scheduledFor: scheduled,
            })),
          )
          .onConflictDoNothing();
    }
    const [saved] = await tx
      .update(marketingCampaign)
      .set({
        status: row.trigger === "manual" ? "scheduled" : "active",
        scheduledFor: scheduled,
        activatedAt: row.trigger === "manual" ? now : scheduled,
        evaluatedAt: null,
        version: row.version + 1,
      })
      .where(eq(marketingCampaign.id, id))
      .returning();
    if (!saved) throw Error("Campaign queue failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action:
        row.trigger === "manual"
          ? "marketing.campaign_scheduled"
          : "marketing.automation_activated",
      entity: "marketing_campaign",
      entityId: id,
      metadata: {
        queueDigest,
        recipients: row.trigger === "manual" ? audience.recipients.length : 0,
        channel: row.channel,
      },
    });
    return (await campaignViews(tx, [saved]))[0]!;
  });
}
export async function cancelCampaign(db: Database, id: string, version: number, p: Principal) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    const row = await campaignRow(tx, id, true);
    if (row.status === "cancelled") return (await campaignViews(tx, [row]))[0]!;
    if (row.version !== version)
      throw new DomainError("version_conflict", "Campaign changed; reload before cancelling");
    await tx
      .update(marketingDelivery)
      .set({ status: "cancelled", reason: "campaign_cancelled" })
      .where(and(eq(marketingDelivery.campaignId, id), eq(marketingDelivery.status, "pending")));
    const [saved] = await tx
      .update(marketingCampaign)
      .set({ status: "cancelled", version: version + 1 })
      .where(eq(marketingCampaign.id, id))
      .returning();
    if (!saved) throw Error("Campaign cancel failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "marketing.campaign_cancelled",
      entity: "marketing_campaign",
      entityId: id,
    });
    return (await campaignViews(tx, [saved]))[0]!;
  });
}
export async function campaignDeliveries(db: Database, id: string, q: CampaignQuery, p: Principal) {
  requirePermission(p, "editCatalog");
  return db.transaction(
    async (tx) => {
      await campaignRow(tx, id);
      const [total] = await tx
        .select({ n: count() })
        .from(marketingDelivery)
        .where(eq(marketingDelivery.campaignId, id));
      const rows = await tx
        .select({ delivery: marketingDelivery, name: clientProfile.name })
        .from(marketingDelivery)
        .innerJoin(clientProfile, eq(marketingDelivery.clientId, clientProfile.id))
        .where(eq(marketingDelivery.campaignId, id))
        .orderBy(desc(marketingDelivery.createdAt), desc(marketingDelivery.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return {
        deliveries: rows.map(({ delivery: row, name }) => ({
          id: row.id,
          clientId: row.clientId,
          clientName: name,
          channel: row.channel,
          status: row.status,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          sentAt: row.sentAt?.toISOString() ?? null,
        })),
        pagination: { page: q.page, pageSize: q.pageSize, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
