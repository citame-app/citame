import { createDb } from "@sob/db";
import { RedisClient } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { startNotificationRuntime } from "./notifications/runtime";

// Fails fast (with every problem listed) when the environment is incomplete.
const config = loadConfig();
const { db } = createDb(config.databaseUrl);
const valkey = new RedisClient(config.valkeyUrl);
await valkey.send("PING", []);

const app = createApp({ db, valkey, config });
await app.ready();

// Optional in-process notification worker (NOTIFY_WORKER_ENABLED). `bun run worker` runs the same code alone.
const notifications = startNotificationRuntime({ db, config });

// Ends open SSE streams and the Valkey subscriber before the process exits.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void Promise.all([app.shutdown(), notifications?.stop()]).finally(() => process.exit(0));
  });
}

export default {
  port: config.port,
  // Bun passes the server as the second argument; Hono exposes it as `c.env` (client IP).
  fetch: (request: Request, server: unknown) => app.fetch(request, server),
};
