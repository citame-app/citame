/**
 * Production entry: `bun server.ts` after `vite build`.
 *
 * Serves the built client, answers `/healthz`, proxies `/api/*` to the Hono API
 * (`API_INTERNAL_URL`) and renders everything else with TanStack Start.
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serveWeb } from "./src/server/listener";
import { createProxy } from "./src/server/proxy";
import { createWebServer } from "./src/server/web-server";

const port = Number(process.env.PORT ?? 4173);
const hostname = process.env.HOST ?? "0.0.0.0";
const apiUrl = process.env.API_INTERNAL_URL ?? "http://localhost:3000";
const trustProxy = process.env.WEB_TRUST_PROXY === "true";
// HSTS only makes sense (and is only honoured) over https: opt in with the public https origin.
const hsts =
  process.env.WEB_HSTS === "true" || (process.env.PUBLIC_URL ?? "").startsWith("https://");

const distDir = join(import.meta.dir, "dist");
const entryUrl = pathToFileURL(join(distDir, "server", "server.js")).href;
const entry = (await import(entryUrl)) as {
  default: { fetch: (request: Request) => Promise<Response> };
};

const web = createWebServer({
  clientDir: join(distDir, "client"),
  ssr: (request) => entry.default.fetch(request),
  proxy: createProxy({ apiUrl, trustProxy }),
  hsts,
  trustProxy,
  log: (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`),
});

const server = serveWeb(web, {
  port,
  hostname,
  idleTimeoutSeconds: Number(process.env.WEB_IDLE_TIMEOUT_SECONDS ?? 30),
  maxRequestBodyBytes: Number(process.env.WEB_MAX_BODY_BYTES ?? 1_048_576),
});

console.log(`web listening on http://${server.hostname}:${server.port} (api: ${apiUrl})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.stop().then(() => process.exit(0));
  });
}
