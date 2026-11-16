import { createDb } from "@sob/db";
import { RedisClient } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { startMaintenance } from "./maintenance";
import { startInventoryExpiry } from "./modules/inventory/runtime";
import { startMembershipBilling } from "./modules/passes/runtime";
import { createProviders } from "./notifications/providers";
import { startNotificationRuntime } from "./notifications/runtime";
import { rootLogger } from "./observability/logger";
import { serveApi } from "./server";

// Fails fast (with every problem listed) when the environment is incomplete.
const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const valkey = new RedisClient(config.valkeyUrl);
await valkey.send("PING", []);

// Account emails (verification, reset, invitation) use the same provider settings as reminders.
const emailProvider = createProviders(config.notifications).email;
const app = createApp({ db, valkey, config, emailProvider });
await app.ready();
const inventoryExpiry = startInventoryExpiry(db);

// Optional in-process notification worker (NOTIFY_WORKER_ENABLED). `bun run worker` runs the same code alone.
const notifications = startNotificationRuntime({ db, config });

// Housekeeping runs where the queue worker runs: in this process only in all-in-one mode.
const maintenance =
  config.notifications.workerEnabled && config.maintenance.enabled
    ? startMaintenance({
        db,
        intervalHours: config.maintenance.intervalHours,
        retention: config.maintenance.retention,
      })
    : null;

const server = serveApi(app, {
  port: config.port,
  idleTimeoutSeconds: config.http.idleTimeoutSeconds,
  maxRequestBodyBytes: config.http.maxRequestBodyBytes,
});
rootLogger.info("api listening", { port: server.port });
const membershipBilling = startMembershipBilling({ db, config });

/**
 * Graceful shutdown, in the order that loses nothing: tell the load balancer first (`/ready`
 * turns 503), wait out the grace period, stop accepting connections and let in-flight requests
 * finish, end SSE streams, stop the worker after its current job, then close Postgres and Valkey.
 */
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  rootLogger.info("shutdown requested", { signal, graceMs: config.shutdownGraceMs });
  app.drain();
  if (config.shutdownGraceMs > 0) await Bun.sleep(config.shutdownGraceMs);
  try {
    await app.shutdown(); // SSE streams must end or `server.stop()` waits for them forever
    await server.stop();
    await emailProvider?.close?.();
    await Promise.all([
      notifications?.stop(),
      maintenance?.stop(),
      inventoryExpiry.stop(),
      membershipBilling?.stop(),
    ]);
    await closeDb();
    valkey.close();
    rootLogger.info("shutdown complete");
    process.exit(0);
  } catch (error) {
    rootLogger.error("shutdown failed", { err: error });
    process.exit(1);
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void shutdown(signal));
}
