import type { Database } from "@sob/db";
import type { RedisClient } from "bun";
import { sql } from "drizzle-orm";
import { processMetrics } from "../notifications/metrics";
import { createHttpMetrics } from "./http";
import { createRegistry, type Registry } from "./metrics";

export interface AppMetrics {
  registry: Registry;
  http: ReturnType<typeof createHttpMetrics>;
  /** Booking attempts by entry point (`rest`, `mcp`) and outcome (`created`, `slot_taken`, ...). */
  booking: ReturnType<Registry["counter"]>;
  syncPush: ReturnType<Registry["counter"]>;
  syncPull: ReturnType<Registry["counter"]>;
  syncPullChanges: ReturnType<Registry["counter"]>;
  /** Plain text of the registry plus the notification worker counters of this process. */
  render(): Promise<string>;
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);

export function createAppMetrics(): AppMetrics {
  const registry = createRegistry();
  return {
    registry,
    http: createHttpMetrics(registry),
    booking: registry.counter("sob_booking_total", "Booking attempts by entry point and outcome.", [
      "source",
      "outcome",
    ]),
    syncPush: registry.counter(
      "sob_sync_push_mutations_total",
      "Offline-sync mutations received by /sync/push, by result and rejection reason.",
      ["status", "reason"],
    ),
    syncPull: registry.counter("sob_sync_pull_requests_total", "Calls to /sync/pull.", []),
    syncPullChanges: registry.counter(
      "sob_sync_pull_changes_total",
      "Change records returned by /sync/pull.",
      [],
    ),
    async render() {
      const own = await registry.renderAsync();
      return `${own}${processMetrics.toPrometheus()}`;
    },
  };
}

/** Sampled at scrape time so a dead dependency shows up as `up 0` instead of a stale number. */
export function registerRuntimeGauges(
  metrics: AppMetrics,
  deps: { db: Database; valkey: RedisClient },
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 2000;
  const { registry } = metrics;

  registry.gauge("sob_db_up", "1 when Postgres answered a trivial query.", [], async () => {
    try {
      await withTimeout(deps.db.execute(sql`select 1`), timeoutMs);
      return [{ labels: {}, value: 1 }];
    } catch {
      return [{ labels: {}, value: 0 }];
    }
  });
  registry.gauge(
    "sob_db_connections",
    "Server-side Postgres connections to this database, by state (all clients).",
    ["state"],
    async () => {
      const rows = await withTimeout(
        deps.db.execute<{ state: string | null; n: number }>(
          sql`select coalesce(state, 'background') as state, count(*)::int as n
              from pg_stat_activity where datname = current_database() group by 1`,
        ),
        timeoutMs,
      );
      return rows.map((row) => ({ labels: { state: row.state ?? "unknown" }, value: row.n }));
    },
  );
  registry.gauge(
    "sob_db_pool_max_connections",
    "Configured size of this process's connection pool (Bun SQL exposes no live pool counters).",
    [],
    () => {
      const client = (deps.db as unknown as { $client?: { options?: { max?: number } } }).$client;
      return [{ labels: {}, value: client?.options?.max ?? 10 }];
    },
  );
  registry.gauge("sob_valkey_up", "1 when Valkey answered PING.", [], async () => {
    try {
      await withTimeout(deps.valkey.send("PING", []), timeoutMs);
      return [{ labels: {}, value: 1 }];
    } catch {
      return [{ labels: {}, value: 0 }];
    }
  });
  registry.gauge("process_resident_memory_bytes", "Resident set size.", [], () => [
    { labels: {}, value: process.memoryUsage().rss },
  ]);
  registry.gauge("process_heap_used_bytes", "JS heap in use.", [], () => [
    { labels: {}, value: process.memoryUsage().heapUsed },
  ]);
  registry.gauge(
    "process_cpu_seconds_total",
    "User plus system CPU time of the process.",
    [],
    () => {
      const usage = process.cpuUsage();
      return [{ labels: {}, value: (usage.user + usage.system) / 1e6 }];
    },
  );
  registry.gauge("process_uptime_seconds", "Seconds since the process started.", [], () => [
    { labels: {}, value: process.uptime() },
  ]);
}
