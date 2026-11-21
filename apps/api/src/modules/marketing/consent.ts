import type { MarketingConsentInput } from "@sob/contracts";
import { type Database, marketingConsent } from "@sob/db";
import { and, asc, eq, inArray, type SQLWrapper, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot, lockClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Connection = Database | Tx;
export function commercialPermissionSql(
  clientId: SQLWrapper,
  channel: "email" | "sms" | SQLWrapper,
) {
  return sql<boolean>`exists (
    select 1 from marketing_consent p where p.client_id=${clientId} and p.channel=${channel} and p.enabled
  ) and not exists (
    select 1 from marketing_consent p
    where p.client_id in (select client_identity_ids(${clientId}))
      and p.channel=${channel} and not p.enabled
  )`;
}

export async function consentFor(db: Connection, clientId: string) {
  const root = await clientRoot(db, clientId);
  const rows = await db
    .select({
      channel: marketingConsent.channel,
      enabled: commercialPermissionSql(marketingConsent.clientId, marketingConsent.channel),
      version: marketingConsent.version,
      source: marketingConsent.source,
      updatedAt: marketingConsent.updatedAt,
    })
    .from(marketingConsent)
    .where(eq(marketingConsent.clientId, root.id));
  const channel = (value: "email" | "sms") => {
    const row = rows.find((row) => row.channel === value);
    return {
      enabled: row?.enabled ?? false,
      version: row?.version ?? 0,
      source: row?.source ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  };
  return { clientId: root.id, email: channel("email"), sms: channel("sms") };
}
export async function setMarketingConsent(
  db: Database,
  clientId: string,
  input: MarketingConsentInput,
  principal: Principal,
  self = false,
) {
  if (!self) requirePermission(principal, "deleteClients");
  if (self && (principal.role !== "client" || principal.clientId !== clientId))
    throw new DomainError("forbidden", "This preference belongs to another client");
  return db.transaction(async (tx) => {
    const root = await lockClientRoot(tx, clientId);
    const ids = await clientIdentityIds(tx, root.id);
    const rows = await tx
      .select()
      .from(marketingConsent)
      .where(
        and(inArray(marketingConsent.clientId, ids), eq(marketingConsent.channel, input.channel)),
      )
      .orderBy(asc(marketingConsent.clientId))
      .for("update");
    const current = rows.find((row) => row.clientId === root.id);
    const source = self ? "Client account choice" : input.source;
    // Reconcile a lost successful response without applying the permission a second time.
    if (
      current?.version === input.version + 1 &&
      current.recordedBy === principal.userId &&
      rows.every(
        (row) =>
          row.enabled === input.enabled &&
          row.source === source &&
          row.recordedBy === principal.userId,
      )
    )
      return consentFor(tx, root.id);
    if ((current?.version ?? 0) !== input.version)
      throw new DomainError(
        "version_conflict",
        "Marketing preference changed; reload before saving",
      );
    for (const id of ids) {
      const previous = rows.find((row) => row.clientId === id);
      await tx
        .insert(marketingConsent)
        .values({
          clientId: id,
          channel: input.channel,
          enabled: input.enabled,
          source,
          version: (previous?.version ?? 0) + 1,
          recordedBy: principal.userId,
        })
        .onConflictDoUpdate({
          target: [marketingConsent.clientId, marketingConsent.channel],
          set: {
            enabled: input.enabled,
            source,
            version: (previous?.version ?? 0) + 1,
            recordedBy: principal.userId,
            updatedAt: new Date(),
          },
        });
    }
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "marketing.consent_recorded",
      entity: "client",
      entityId: root.id,
      metadata: {
        channel: input.channel,
        enabled: input.enabled,
        source: self ? "client_account" : "salon_record",
      },
    });
    return consentFor(tx, root.id);
  });
}
export async function unsubscribeMarketing(
  db: Database,
  clientId: string,
  channel: "email" | "sms",
) {
  return db.transaction(async (tx) => {
    const root = await lockClientRoot(tx, clientId);
    const ids = await clientIdentityIds(tx, root.id);
    for (const id of ids)
      await tx
        .insert(marketingConsent)
        .values({
          clientId: id,
          channel,
          enabled: false,
          source: "Public opt-out link",
          version: 1,
        })
        .onConflictDoUpdate({
          target: [marketingConsent.clientId, marketingConsent.channel],
          set: {
            enabled: false,
            source: "Public opt-out link",
            version: sql`${marketingConsent.version}+1`,
            updatedAt: new Date(),
          },
        });
    await recordAudit(tx, {
      actorUserId: null,
      action: "marketing.unsubscribed",
      entity: "client",
      entityId: root.id,
      metadata: { channel },
    });
    return { unsubscribed: true as const };
  });
}

/** The caller must hold the active client profile lock used for consent edits. */
export async function withdrawContactEmailConsent(tx: Tx, clientId: string, actorId: string) {
  await tx
    .update(marketingConsent)
    .set({
      enabled: false,
      source: "Contact email changed",
      version: sql`${marketingConsent.version}+1`,
      recordedBy: actorId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(marketingConsent.clientId, clientId),
        eq(marketingConsent.channel, "email"),
        eq(marketingConsent.enabled, true),
      ),
    );
}
