import { createDb } from "@sob/db";
import { RedisClient } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { rootLogger } from "./observability/logger";
import { startNotificationRuntime } from "./notifications/runtime";

// Fails fast (with every problem listed) when the environment is incomplete.
const config = loadConfig();
const { db, close: closeDb } = createDb(config.databaseUrl);
const valkey = new RedisClient(config.valkeyUrl);
await valkey.send("PING", []);

const app = createApp({ db, valkey, config });
await app.ready();

// Optional in-process notification worker (NOTIFY_WORKER_ENABLED). `bun run worker` runs the same code alone.
const notifications = startNotificationRuntime({ db, config });

const server = Bun.serve({
  port: config.port,
  // Bun passes the server as the second argument; Hono exposes it as `c.env` (client IP).
  fetch: (request, bunServer) => app.fetch(request, bunServer),
});
rootLogger.info("api listening", { port: server.port });

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
    await notifications?.stop();
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
