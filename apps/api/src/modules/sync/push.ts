import {
  type SyncMutation,
  type SyncMutationResult,
  type SyncPushRequest,
  type SyncPushResponse,
  syncMutationSchema,
} from "@sob/contracts";
import { type Database, syncMutation } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { rootLogger } from "../../observability/logger";
import { type ApplyContext, applyMutation, rejectionReason } from "./apply";
import { headSeq } from "./pull";

type StoredRow = typeof syncMutation.$inferSelect;
type Executor = Pick<Database, "select">;

async function readStored(db: Executor, mutationId: string): Promise<StoredRow | undefined> {
  const [row] = await db.select().from(syncMutation).where(eq(syncMutation.mutationId, mutationId));
  return row;
}

function toResult(row: StoredRow, principal: Principal, replayed: boolean): SyncMutationResult {
  // A mutation id is a capability: another user's stored result is never revealed.
  if (row.userId !== principal.userId) {
    return {
      mutationId: row.mutationId,
      status: "rejected",
      reason: "invalid",
      message: "This mutation id has already been used",
      replayed: false,
    };
  }
  if (row.status === "applied") {
    return { mutationId: row.mutationId, status: "applied", appliedSeq: row.appliedSeq, replayed };
  }
  const stored = row.result as { reason?: string; message?: string };
  return {
    mutationId: row.mutationId,
    status: "rejected",
    reason: (stored.reason ?? "invalid") as never,
    message: stored.message ?? "Rejected",
    replayed,
  };
}

/**
 * Processes one mutation exactly once per `mutation_id`. The write and its ledger row commit in
 * one transaction; a per-id advisory lock serializes concurrent deliveries of the same id, so the
 * loser finds the winner's stored result. Rejections are stored too, so a replay is answered
 * identically even if the world changed since.
 */
async function processOne(
  ctx: ApplyContext & { db: Database },
  principal: Principal,
  deviceId: string,
  raw: { mutationId: string },
  parsed: ReturnType<typeof syncMutationSchema.safeParse>,
  previousAppointmentEditRejected: boolean,
): Promise<SyncMutationResult> {
  const { db } = ctx;
  const id = raw.mutationId;
  const existing = await readStored(db, id);
  if (existing) return toResult(existing, principal, true);

  const kind = parsed.success
    ? parsed.data.kind
    : String((raw as { kind?: unknown }).kind ?? "unknown");
  const entry = { mutationId: id, deviceId, userId: principal.userId, kind };

  const created = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`sob.sync_mutation:${id}`}, 0))`,
    );
    if (await readStored(tx, id)) return false;

    if (!parsed.success || previousAppointmentEditRejected) {
      const result = parsed.success
        ? {
            reason: "conflict",
            message: "Review this edit after an earlier appointment change was rejected",
          }
        : {
            reason: "invalid",
            message: parsed.error.issues
              .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
              .join("; "),
          };
      await tx.insert(syncMutation).values({ ...entry, status: "rejected", result });
      return true;
    }

    try {
      await tx.transaction(async (changes) => {
        await changes.execute(sql`select set_config('sob.mutation_id', ${id}, true)`);
        await applyMutation(changes as unknown as Database, principal, parsed.data, ctx);
        await changes.insert(syncMutation).values({ ...entry, status: "applied", result: {} });
        // Run deferred constraints while a rejection can still roll back the changes alone.
        // Sync triggers can now fill applied_seq. The outer transaction takes no more write locks.
        await changes.execute(sql`set constraints all immediate`);
      });
    } catch (error) {
      const rejection = rejectionReason(error);
      if (!rejection) throw error;
      await tx.insert(syncMutation).values({ ...entry, status: "rejected", result: rejection });
    }
    return true;
  });

  const stored = await readStored(db, id);
  if (!stored) throw new Error("Mutation ledger row missing after processing");
  return toResult(stored, principal, !created);
}

function appointmentBasis(mutation: SyncMutation) {
  switch (mutation.kind) {
    case "appointment.create":
      return { id: mutation.payload.id.toLowerCase(), version: 0 };
    case "appointment.reschedule":
    case "appointment.cancel":
    case "appointment.set_notes":
    case "appointment.set_status":
      return { id: mutation.payload.id.toLowerCase(), version: mutation.payload.version };
    default:
      return undefined;
  }
}

/** Applies a batch in order. A transient failure stops the batch; the rest come back as `retry`. */
export async function pushMutations(
  ctx: ApplyContext & { db: Database },
  principal: Principal,
  request: SyncPushRequest,
): Promise<SyncPushResponse> {
  const results: SyncMutationResult[] = [];
  const rejectedAppointments = new Map<string, number>();
  let failure: string | null = null;
  for (const raw of request.mutations) {
    if (failure !== null) {
      results.push({
        mutationId: raw.mutationId,
        status: "retry",
        message: "Not processed: an earlier mutation in this batch failed; resend it",
      });
      continue;
    }
    try {
      const parsed = syncMutationSchema.safeParse(raw);
      const basis = parsed.success ? appointmentBasis(parsed.data) : undefined;
      const rejectedVersion = basis ? rejectedAppointments.get(basis.id) : undefined;
      const result = await processOne(
        ctx,
        principal,
        request.deviceId,
        raw,
        parsed,
        basis !== undefined && rejectedVersion !== undefined && basis.version > rejectedVersion,
      );
      if (basis && result.status === "rejected")
        rejectedAppointments.set(
          basis.id,
          Math.min(rejectedVersion ?? basis.version, basis.version),
        );
      results.push(result);
    } catch (error) {
      rootLogger.error("sync push: transient failure", { err: error });
      failure = "failed";
      results.push({
        mutationId: raw.mutationId,
        status: "retry",
        message: "Temporary server error; resend with backoff",
      });
    }
  }
  return { results, headSeq: await headSeq(ctx.db) };
}
