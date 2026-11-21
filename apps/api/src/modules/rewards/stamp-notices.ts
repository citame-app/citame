import {
  type StampNotice,
  type StampNoticeQuery,
  type StampNoticeRead,
  stampProgramTermsSchema,
} from "@sob/contracts";
import {
  clientProfile,
  type Database,
  stampCard,
  stampProgram,
  stampRewardNoticeRead,
} from "@sob/db";
import { and, count, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { requirePermission, requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

function audience(principal: Principal, mode: "admin" | "client") {
  if (mode === "admin") {
    requirePermission(principal, "commerce");
    requirePermission(principal, "clients");
    return undefined;
  }
  requireRole(principal, "client");
  if (!principal.clientId) throw new DomainError("forbidden", "Customer account required");
  return principal.clientId;
}

function eligible(scope: string | undefined, now: Date) {
  return and(
    isNull(clientProfile.deletedAt),
    scope ? sql`${stampCard.clientId} in (select client_identity_ids(${scope}::uuid))` : undefined,
    isNotNull(stampCard.completedAt),
    isNull(stampCard.redeemedAt),
    isNull(stampCard.voidedAt),
    sql`not ${stampCard.needsReview}`,
    or(isNull(stampCard.rewardExpiresAt), gt(stampCard.rewardExpiresAt, now)),
    gte(stampCard.programVersion, sql`coalesce(${stampProgram.minimumCardVersion}, 1)`),
  );
}

function activeCards(tx: Pick<Tx, "select">, scope: string | undefined, now: Date) {
  return tx
    .select({
      cardId: sql<string>`${stampCard.id}`.as("notice_card_id"),
      clientId: sql<string>`${clientProfile.id}`.as("notice_client_id"),
      clientName: clientProfile.name,
      program: stampCard.program,
      earnedAt: stampCard.completedAt,
      issuedAt: stampCard.rewardIssuedAt,
      expiresAt: stampCard.rewardExpiresAt,
    })
    .from(stampCard)
    .innerJoin(clientProfile, eq(clientProfile.id, sql`client_root_id(${stampCard.clientId})`))
    .leftJoin(stampProgram, eq(stampProgram.id, 1))
    .where(eligible(scope, now))
    .as("active_stamp_notices");
}

export async function listStampNotices(
  db: Database,
  principal: Principal,
  mode: "admin" | "client",
  generation: string,
  query: StampNoticeQuery,
  now: Date,
) {
  const scope = audience(principal, mode);
  const page = query.page ?? 1;
  const pageSize = 20;
  return db.transaction(
    async (tx) => {
      const active = activeCards(tx, scope, now);
      const read = and(
        eq(stampRewardNoticeRead.cardId, active.cardId),
        eq(stampRewardNoticeRead.userId, principal.userId),
        eq(stampRewardNoticeRead.earnedAt, active.earnedAt),
      );
      const unread = isNull(stampRewardNoticeRead.cardId);
      const [totals] = await tx
        .select({
          total: count(),
          unread: sql<number>`count(*) filter (where ${unread})`.mapWith(Number),
        })
        .from(active)
        .leftJoin(stampRewardNoticeRead, read);
      const unreadCount = totals?.unread ?? 0;
      const total = query.unread === "true" ? unreadCount : (totals?.total ?? 0);
      if (query.summary === "true")
        return { entries: [], generation, unreadCount, page, pageSize, total };
      const rows = await tx
        .select({
          cardId: active.cardId,
          clientId: active.clientId,
          clientName: active.clientName,
          program: active.program,
          earnedAt: active.earnedAt,
          issuedAt: active.issuedAt,
          expiresAt: active.expiresAt,
          receipt: stampRewardNoticeRead.cardId,
        })
        .from(active)
        .leftJoin(stampRewardNoticeRead, read)
        .where(query.unread === "true" ? unread : undefined)
        .orderBy(desc(active.earnedAt), desc(active.cardId))
        .limit(pageSize)
        .offset((page - 1) * pageSize);
      const entries = rows.map((row): StampNotice => {
        if (!row.earnedAt) throw new Error("An eligible reward notice needs an earned instant");
        const terms = stampProgramTermsSchema.parse(row.program);
        return {
          cardId: row.cardId,
          clientId: scope ? null : row.clientId,
          clientName: scope ? null : row.clientName,
          cardName: terms.name,
          rewardName: terms.reward.name,
          earnedAt: row.earnedAt.toISOString(),
          rewardExpiresAt: row.expiresAt?.toISOString() ?? null,
          issued: row.issuedAt !== null,
          read: row.receipt !== null,
        };
      });
      return { entries, generation, unreadCount, page, pageSize, total };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function readStampNotice(
  db: Database,
  principal: Principal,
  mode: "admin" | "client",
  input: StampNoticeRead,
  now: Date,
) {
  const scope = audience(principal, mode);
  const earnedAt = new Date(input.earnedAt);
  await db.transaction(async (tx) => {
    const active = activeCards(tx, scope, now);
    const [notice] = await tx
      .select({ id: active.cardId })
      .from(active)
      .where(and(eq(active.cardId, input.cardId), eq(active.earnedAt, earnedAt)));
    if (!notice) throw new DomainError("not_found", "Reward notice is no longer available");
    await tx
      .insert(stampRewardNoticeRead)
      .values({ cardId: notice.id, userId: principal.userId, earnedAt })
      .onConflictDoUpdate({
        target: [stampRewardNoticeRead.cardId, stampRewardNoticeRead.userId],
        set: { earnedAt },
        setWhere: lt(stampRewardNoticeRead.earnedAt, earnedAt),
      });
  });
  return { ok: true as const };
}
