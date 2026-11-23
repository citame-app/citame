import { type Database, reminder } from "@sob/db";
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";

export const WHATSAPP_DELIVERY_UNKNOWN = "whatsapp_delivery_unknown";

export type ReminderRow = typeof reminder.$inferSelect;

export interface ClaimOptions {
  now: Date;
  limit: number;
  visibilitySeconds: number;
  workerId: string;
  maxAttempts: number;
}

/**
 * Claims due jobs. Postgres is the queue (ADR 0010): `FOR UPDATE SKIP LOCKED` makes concurrent
 * workers take disjoint rows, and the lease (`locked_until`) is the visibility timeout. A
 * `processing` row whose lease expired belongs to a worker that crashed or stalled, so it is
 * claimable again, except when it already used every attempt: that one is dead-lettered.
 * Claiming increments `attempts`, so a job that keeps killing its worker still terminates.
 */
export async function claimDue(db: Database, options: ClaimOptions): Promise<ReminderRow[]> {
  const { now } = options;
  return db.transaction(async (tx) => {
    await tx
      .update(reminder)
      .set({
        status: "failed",
        lockedUntil: null,
        lastError: sql`case when ${reminder.whatsappDispatchAt} is not null
          then ${WHATSAPP_DELIVERY_UNKNOWN}
          else 'lease expired after the last attempt (worker crashed or stalled)' end`,
        updatedAt: now,
      })
      .where(
        and(
          eq(reminder.status, "processing"),
          lt(reminder.lockedUntil, now),
          gte(reminder.attempts, options.maxAttempts),
        ),
      );
    const due = await tx
      .select({ id: reminder.id })
      .from(reminder)
      .where(
        and(
          lte(reminder.scheduledFor, now),
          or(
            eq(reminder.status, "pending"),
            and(eq(reminder.status, "processing"), lt(reminder.lockedUntil, now)),
          ),
        ),
      )
      .orderBy(reminder.scheduledFor, reminder.id)
      .limit(options.limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return [];
    return tx
      .update(reminder)
      .set({
        status: "processing",
        attempts: sql`${reminder.attempts} + 1`,
        lockedUntil: new Date(now.getTime() + options.visibilitySeconds * 1000),
        lockedBy: options.workerId,
        updatedAt: now,
      })
      .where(
        inArray(
          reminder.id,
          due.map((d) => d.id),
        ),
      )
      .returning();
  });
}

/**
 * Extends the lease on claimed rows this worker still owns and returns the ids it still owns.
 * A batch is processed one job at a time under the lease taken at claim time, so a slow job
 * would otherwise let the leases of the jobs behind it expire and a second worker claim (and
 * send) them too.
 */
export async function renewLeases(
  db: Database,
  ids: string[],
  workerId: string,
  now: Date,
  visibilitySeconds: number,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const renewed = await db
    .update(reminder)
    .set({
      lockedUntil: sql`greatest(${reminder.lockedUntil}, ${new Date(now.getTime() + visibilitySeconds * 1000).toISOString()}::timestamptz)`,
    })
    .where(
      and(
        inArray(reminder.id, ids),
        eq(reminder.status, "processing"),
        eq(reminder.lockedBy, workerId),
      ),
    )
    .returning({ id: reminder.id });
  return renewed.map((r) => r.id);
}

/** Returns reserved jobs that this worker never started, without charging a delivery attempt. */
export async function releaseUnstartedReminders(db: Database, ids: string[], workerId: string) {
  if (!ids.length) return;
  await db
    .update(reminder)
    .set({
      status: "pending",
      lockedBy: null,
      lockedUntil: null,
      attempts: sql`${reminder.attempts} - 1`,
    })
    .where(
      and(
        inArray(reminder.id, ids),
        eq(reminder.status, "processing"),
        eq(reminder.lockedBy, workerId),
      ),
    );
}

/**
 * Ends a claim. Fenced on `locked_by` and `processing`: a worker whose lease was taken over
 * cannot overwrite the new owner's outcome. Returns whether the claim was still ours.
 */
export async function finishClaim(
  db: Database,
  row: Pick<ReminderRow, "id" | "attempts">,
  workerId: string,
  outcome:
    | { status: "sent"; providerMessageId: string; at: Date }
    | { status: "skipped"; reason: string }
    | { status: "failed"; error: string; clearWhatsAppDispatch?: boolean }
    | { status: "pending"; error: string; retryAt: Date; clearWhatsAppDispatch?: boolean },
): Promise<boolean> {
  // `locked_by` stays as a record of the last worker that handled the row.
  const common = {
    lockedUntil: null,
    ...("clearWhatsAppDispatch" in outcome && outcome.clearWhatsAppDispatch
      ? { whatsappDispatchAt: null, whatsappDispatchWabaId: null, whatsappDispatchPhoneId: null }
      : {}),
  };
  const changes =
    outcome.status === "sent"
      ? {
          ...common,
          status: "sent" as const,
          providerMessageId: outcome.providerMessageId,
          sentAt: outcome.at,
          lastError: null,
        }
      : outcome.status === "skipped"
        ? { ...common, status: "skipped" as const, lastError: outcome.reason }
        : outcome.status === "failed"
          ? { ...common, status: "failed" as const, lastError: outcome.error }
          : {
              ...common,
              status: "pending" as const,
              lastError: outcome.error,
              scheduledFor: outcome.retryAt,
            };
  const updated = await db
    .update(reminder)
    .set(changes)
    .where(
      and(
        eq(reminder.id, row.id),
        eq(reminder.status, "processing"),
        eq(reminder.lockedBy, workerId),
        eq(reminder.attempts, row.attempts),
      ),
    )
    .returning({ id: reminder.id });
  return updated.length === 1;
}

/** Delay before retry number `attempt` (1-based): exponential, capped, with equal jitter. */
export function backoffMs(
  attempt: number,
  baseSeconds: number,
  maxSeconds: number,
  random: () => number,
): number {
  const raw = Math.min(baseSeconds * 2 ** (attempt - 1), maxSeconds) * 1000;
  return Math.round(raw * (0.5 + 0.5 * random()));
}
