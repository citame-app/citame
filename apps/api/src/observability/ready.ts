import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { sql } from "drizzle-orm";

export type CheckResult = "ok" | "fail";

export interface ReadyReport {
  status: "ready" | "unavailable";
  checks: { database: CheckResult; valkey: CheckResult };
}

async function probe(run: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return "ok";
  } catch {
    // The reason is deliberately not returned: /ready may be reachable from outside.
    return "fail";
  } finally {
    clearTimeout(timer);
  }
}

/** Readiness: can this instance serve traffic right now? Liveness (`/health`) never asks. */
export async function checkReady(
  deps: { db: Database; valkey: RedisClient },
  timeoutMs = 2000,
): Promise<ReadyReport> {
  const [database, valkey] = await Promise.all([
    probe(() => deps.db.execute(sql`select 1`), timeoutMs),
    probe(() => deps.valkey.send("PING", []), timeoutMs),
  ]);
  return {
    status: database === "ok" && valkey === "ok" ? "ready" : "unavailable",
    checks: { database, valkey },
  };
}
