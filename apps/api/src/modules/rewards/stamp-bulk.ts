import {
  type StampBulkInput,
  type StampBulkResult,
  type StampBulkReview,
  type StampBulkScope,
  stampBulkResultSchema,
} from "@sob/contracts";
import { auditLog, type Database, stampCard, stampCardEvent } from "@sob/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { rewardHash } from "./accounts";
import { currentProgram, lockStampProgram } from "./stamps";

const auditAction = "rewards.stamp_cards_voided";
type Counts = StampBulkReview["counts"];

function candidateCards(tx: Tx, minimumVersion: number, now: Date) {
  return tx
    .select({
      id: stampCard.id,
      version: stampCard.version,
      state: sql<keyof Counts>`case
      when ${stampCard.completedAt} is null and ${stampCard.stampExpiresAt} <= ${now} then 'expired'
      when ${stampCard.completedAt} is null then 'active'
      when ${stampCard.rewardExpiresAt} <= ${now} then 'expired'
      when ${stampCard.rewardIssuedAt} is not null then 'issued'
      else 'completed'
    end`.as("card_state"),
    })
    .from(stampCard)
    .where(
      and(
        gte(stampCard.programVersion, minimumVersion),
        isNull(stampCard.redeemedAt),
        isNull(stampCard.voidedAt),
      ),
    )
    .as("bulk_stamp_candidates");
}

function filterCards(tx: Tx, scope: StampBulkScope, minimumVersion: number, now: Date) {
  const candidates = candidateCards(tx, minimumVersion, now);
  return tx
    .select()
    .from(candidates)
    .where(scope === "all" ? undefined : eq(candidates.state, scope))
    .as("reviewed_stamp_cards");
}

async function reviewIn(
  tx: Tx,
  principal: Principal,
  scope: StampBulkScope,
  generation: string,
  now: Date,
) {
  const program = await currentProgram(tx);
  const cards = filterCards(tx, scope, program.minimumCardVersion, now);
  const countFor = (state: keyof Counts) =>
    sql<number>`count(*) filter (where ${cards.state} = ${state})`.mapWith(Number);
  const [summary] = await tx
    .select({
      fingerprint: sql<string>`encode(sha256(convert_to(coalesce(string_agg(
      concat(${cards.id}, ':', ${cards.version}, ':', ${cards.state}), ',' order by ${cards.id}
    ), ''), 'UTF8')), 'hex')`,
      active: countFor("active"),
      completed: countFor("completed"),
      issued: countFor("issued"),
      expired: countFor("expired"),
    })
    .from(cards);
  if (!summary) throw new Error("Missing bulk stamp review");
  const { fingerprint, ...counts } = summary;
  const review: StampBulkReview = {
    scope,
    generation,
    counts,
    total: counts.active + counts.completed + counts.issued + counts.expired,
    reviewFingerprint: rewardHash({
      actor: principal.userId,
      scope,
      generation,
      programme: program.version,
      fingerprint,
    }),
  };
  return { review, cards };
}

export async function reviewBulkStampCards(
  db: Database,
  principal: Principal,
  scope: StampBulkScope,
  generation: string,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(
    async (tx) => (await reviewIn(tx, principal, scope, generation, now)).review,
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export async function bulkVoidStampCards(
  db: Database,
  principal: Principal,
  input: StampBulkInput,
  now: Date,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    // Other stamp mutations take the shared lock after any client lock. Bulk work never locks clients.
    await lockStampProgram(tx);
    const requestFingerprint = rewardHash(input);
    const [previous] = await tx
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entity, "stamp_card_batch"),
          eq(auditLog.entityId, input.idempotencyKey),
          eq(auditLog.actorUserId, principal.userId),
          eq(auditLog.action, auditAction),
        ),
      )
      .limit(1);
    if (previous) {
      if (previous.metadata.requestFingerprint !== requestFingerprint)
        throw new DomainError(
          "version_conflict",
          "This request key was used for a different batch",
        );
      return stampBulkResultSchema.parse(previous.metadata.receipt);
    }

    const { review, cards } = await reviewIn(tx, principal, input.scope, input.generation, now);
    if (review.reviewFingerprint !== input.reviewFingerprint)
      throw new DomainError(
        "version_conflict",
        "The selected cards changed. Review the current batch",
      );
    if (!review.total) throw new DomainError("invalid_state", "No stamp cards match");

    const targets = tx.select({ id: cards.id }).from(cards);
    const sourcePrefix = `bulk:${principal.userId}:${input.idempotencyKey}:`;
    const [changed] = await tx.execute<{ total: number }>(sql`
      with changed as (
        update ${stampCard}
        set voided_at = ${now.toISOString()}, updated_at = ${now.toISOString()}, version = version + 1
        where id in (${targets})
        returning id
      ), recorded as (
        insert into ${stampCardEvent} (source, card_id, request_hash)
        select ${sourcePrefix} || id::text, id, ${requestFingerprint} from changed
        returning card_id
      )
      select count(*)::int as total from recorded
    `);
    if (changed?.total !== review.total)
      throw new DomainError(
        "version_conflict",
        "The selected cards changed. Review the current batch",
      );
    const receipt: StampBulkResult = {
      scope: input.scope,
      generation: input.generation,
      idempotencyKey: input.idempotencyKey,
      total: review.total,
      voidedAt: now.toISOString(),
    };
    await recordAudit(tx, {
      actorUserId: principal.userId,
      entity: "stamp_card_batch",
      entityId: input.idempotencyKey,
      action: auditAction,
      metadata: { receipt, reason: input.reason, requestFingerprint },
    });
    return receipt;
  });
}
