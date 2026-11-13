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

export default {
  port: config.port,
  // Bun passes the server as the second argument; Hono exposes it as `c.env` (client IP).
  fetch: (request: Request, server: unknown) => app.fetch(request, server),
};
