import { DESKTOP_CLIENT_ID } from "@sob/contracts";
import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import { compactSyncLog } from "./modules/sync/compact";
import type { Logger } from "./observability/logger";
import { rootLogger } from "./observability/logger";

/**
 * Scheduled housekeeping (docs/operations.md). Everything here only removes data that nothing
 * can read any more, or that is past a documented retention window:
 *
 * - `sync_change` rows a later entry of the same row superseded (see `compactSyncLog`).
 *   Tombstones are kept on purpose (ADR 0007).
 * - finished reminder rows (sent, skipped, cancelled) and, later, dead letters. Pending and
 *   in-flight rows are never touched.
 * - OAuth access/refresh tokens that expired more than a grace period ago, idle dynamically
 *   registered clients (no token, no consent), expired verification values and sessions.
 *
 * It takes a transaction-scoped advisory lock, so any number of workers can run it without
 * stepping on each other: the first one works, the others report `skipped`.
 */
export interface Retention {
  syncLogDays: number;
  reminderDays: number;
  deadLetterDays: number;
  oauthGraceDays: number;
  idleClientDays: number;
}

export const DEFAULT_RETENTION: Retention = {
  syncLogDays: 30,
  reminderDays: 90,
  deadLetterDays: 180,
  oauthGraceDays: 7,
  idleClientDays: 30,
};

export interface MaintenanceReport {
  /** True when another process held the lock: nothing was done. */
  skipped: boolean;
  syncLogRemoved: number;
  remindersRemoved: number;
  oauthTokensRemoved: number;
  oauthClientsRemoved: number;
  verificationsRemoved: number;
  sessionsRemoved: number;
}

const LOCK_KEY = 8_005_001; // arbitrary, unique to this job within the database

const EMPTY: MaintenanceReport = {
  skipped: false,
  syncLogRemoved: 0,
  remindersRemoved: 0,
  oauthTokensRemoved: 0,
  oauthClientsRemoved: 0,
  verificationsRemoved: 0,
  sessionsRemoved: 0,
};

const daysBefore = (now: Date, days: number) => new Date(now.getTime() - days * 86_400_000);

export async function runMaintenance(
  db: Database,
  options: { now?: Date; retention?: Partial<Retention>; logger?: Logger } = {},
): Promise<MaintenanceReport> {
  const now = options.now ?? new Date();
  const r = { ...DEFAULT_RETENTION, ...options.retention };
  const log = (options.logger ?? rootLogger).child({ component: "maintenance" });

  const report = await db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(
      sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`,
    );
    if (!lock?.locked) return { ...EMPTY, skipped: true };

    const done = { ...EMPTY };
    const removed = async (query: ReturnType<typeof sql>) => (await tx.execute(query)).length;

    done.syncLogRemoved = await compactSyncLog(tx as unknown as Database, {
      olderThan: daysBefore(now, r.syncLogDays),
    });

    done.remindersRemoved =
      (await removed(sql`
        delete from reminder
        where status in ('sent', 'skipped', 'cancelled') and updated_at < ${daysBefore(now, r.reminderDays)}
        returning id`)) +
      (await removed(sql`
        delete from reminder
        where status = 'failed' and updated_at < ${daysBefore(now, r.deadLetterDays)}
        returning id`));

    const tokenCutoff = daysBefore(now, r.oauthGraceDays);
    // Refresh tokens first: their access tokens cascade. Then the stragglers.
    done.oauthTokensRemoved =
      (await removed(sql`
        delete from oauth_refresh_token where expires_at < ${tokenCutoff} returning id`)) +
      (await removed(sql`
        delete from oauth_access_token where expires_at < ${tokenCutoff} returning id`));
    await removed(
      sql`delete from oauth_client_assertion where expires_at < ${tokenCutoff} returning id`,
    );

    done.oauthClientsRemoved = await removed(sql`
      delete from oauth_client c
      where c.client_id <> ${DESKTOP_CLIENT_ID}
        and c.created_at < ${daysBefore(now, r.idleClientDays)}
        and not exists (select 1 from oauth_access_token t where t.client_id = c.client_id)
        and not exists (select 1 from oauth_refresh_token t where t.client_id = c.client_id)
        and not exists (select 1 from oauth_consent t where t.client_id = c.client_id)
      returning c.id`);

    done.verificationsRemoved = await removed(sql`
      delete from verification where expires_at < ${daysBefore(now, 1)} returning id`);
    done.sessionsRemoved = await removed(sql`
      delete from session where expires_at < ${daysBefore(now, 1)} returning id`);
    return done;
  });

  if (report.skipped) log.info("maintenance skipped: another process holds the lock");
  else log.info("maintenance finished", { ...report });
  return report;
}

export interface MaintenanceSchedule {
  stop(): Promise<void>;
}

/**
 * Runs `runMaintenance` shortly after start and then every `intervalHours`. A failed run is
 * logged and retried at the next tick; it never takes the process down.
 */
export function startMaintenance(options: {
  db: Database;
  intervalHours: number;
  retention?: Partial<Retention>;
  logger?: Logger;
  firstRunDelayMs?: number;
}): MaintenanceSchedule {
  const log = (options.logger ?? rootLogger).child({ component: "maintenance" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<unknown> = Promise.resolve();
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    running = runMaintenance(options.db, { retention: options.retention, logger: options.logger })
      .catch((error) => log.error("maintenance failed", { err: error }))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, options.intervalHours * 3_600_000);
      });
  };
  timer = setTimeout(tick, options.firstRunDelayMs ?? 60_000);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
