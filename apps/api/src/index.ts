import { createDb } from "@sob/db";
import { RedisClient } from "bun";
import { createApp } from "./app";
import { loadConfig } from "./config";

// Fails fast (with every problem listed) when the environment is incomplete.
const config = loadConfig();
const { db } = createDb(config.databaseUrl);
const valkey = new RedisClient(config.valkeyUrl);
await valkey.send("PING", []);

const app = createApp({ db, valkey, config });

// Ends open SSE streams and the Valkey subscriber before the process exits.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void app.shutdown().finally(() => process.exit(0));
  });
}

export default {
  port: config.port,
  // Bun passes the server as the second argument; Hono exposes it as `c.env` (client IP).
  fetch: (request: Request, server: unknown) => app.fetch(request, server),
};
