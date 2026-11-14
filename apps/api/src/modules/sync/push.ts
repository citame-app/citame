import {
  type SyncMutationResult,
  type SyncPushRequest,
  type SyncPushResponse,
  syncMutationSchema,
} from "@sob/contracts";
import { type Database, syncMutation } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import type { Principal } from "../../auth/principal";
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
): Promise<SyncMutationResult> {
  const { db } = ctx;
  const id = raw.mutationId;
  const existing = await readStored(db, id);
  if (existing) return toResult(existing, principal, true);

  const parsed = syncMutationSchema.safeParse(raw);
  let created = false;

  const record = async (
    tx: Pick<Database, "insert">,
    status: "applied" | "rejected",
    kind: string,
    result: Record<string, unknown>,
  ) => {
    const inserted = await tx
      .insert(syncMutation)
      .values({ mutationId: id, deviceId, userId: principal.userId, kind, status, result })
      .onConflictDoNothing()
      .returning({ id: syncMutation.mutationId });
    created = inserted.length > 0;
  };
  const kind = parsed.success
    ? parsed.data.kind
    : String((raw as { kind?: unknown }).kind ?? "unknown");

  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    await record(db, "rejected", kind, { reason: "invalid", message });
  } else {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`sob.sync_mutation:${id}`}, 0))`,
        );
        if (await readStored(tx, id)) return;
        await tx.execute(sql`select set_config('sob.mutation_id', ${id}, true)`);
        await applyMutation(tx as unknown as Database, principal, parsed.data, ctx);
        await record(tx, "applied", kind, {});
      });
    } catch (error) {
      const rejection = rejectionReason(error);
      if (!rejection) throw error;
      await record(db, "rejected", kind, rejection);
    }
  }

  const stored = await readStored(db, id);
  if (!stored) throw new Error("Mutation ledger row missing after processing");
  return toResult(stored, principal, !created);
}

/** Applies a batch in order. A transient failure stops the batch; the rest come back as `retry`. */
export async function pushMutations(
  ctx: ApplyContext & { db: Database },
  principal: Principal,
  request: SyncPushRequest,
): Promise<SyncPushResponse> {
  const results: SyncMutationResult[] = [];
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
      results.push(await processOne(ctx, principal, request.deviceId, raw));
    } catch (error) {
      console.error("sync push: transient failure", error);
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
