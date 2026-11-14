import { createDb } from "@sob/db";
import { loadConfig } from "./config";
import { startNotificationRuntime } from "./notifications/runtime";

/**
 * Standalone notification worker (`bun run worker`): same code as the in-process worker, for
 * deployments that want to scale or restart it independently of the HTTP API. It runs
 * regardless of NOTIFY_WORKER_ENABLED, which only governs the API process.
 */
const loaded = loadConfig();
const config = { ...loaded, notifications: { ...loaded.notifications, workerEnabled: true } };
const { db, close } = createDb(config.databaseUrl);
const runtime = startNotificationRuntime({ db, config });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void (async () => {
      await runtime?.stop();
      await close();
      process.exit(0);
    })();
  });
}
