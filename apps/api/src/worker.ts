import { createDb } from "@sob/db";
import { loadConfig } from "./config";
import { startMaintenance } from "./maintenance";
import { startInventoryExpiry } from "./modules/inventory/runtime";
import { startNotificationRuntime } from "./notifications/runtime";
import { rootLogger } from "./observability/logger";

/**
 * Standalone background worker (`bun run worker`): the reminder queue and the scheduled
 * housekeeping, for deployments that want to scale or restart them independently of the HTTP
 * API. The queue runs regardless of NOTIFY_WORKER_ENABLED, which only governs the API process;
 * housekeeping follows MAINTENANCE_ENABLED. Both are safe to run in several replicas at once
 * (SKIP LOCKED claims, an advisory lock for housekeeping).
 */
const loaded = loadConfig();
const config = { ...loaded, notifications: { ...loaded.notifications, workerEnabled: true } };
const { db, close } = createDb(config.databaseUrl);
const runtime = startNotificationRuntime({ db, config });
const inventoryExpiry = startInventoryExpiry(db);
const maintenance = config.maintenance.enabled
  ? startMaintenance({
      db,
      intervalHours: config.maintenance.intervalHours,
      retention: config.maintenance.retention,
    })
  : null;
rootLogger.info("worker started", { maintenance: config.maintenance.enabled });

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  rootLogger.info("worker shutdown requested", { signal });
  try {
    await Promise.all([runtime?.stop(), maintenance?.stop(), inventoryExpiry.stop()]);
    await close();
    rootLogger.info("worker shutdown complete");
    process.exit(0);
  } catch (error) {
    rootLogger.error("worker shutdown failed", { err: error });
    process.exit(1);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
