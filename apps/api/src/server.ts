import type { App } from "./app";

export interface ServeOptions {
  port: number;
  /** Seconds a connection may sit without traffic before Bun closes it (0 disables, max 255). */
  idleTimeoutSeconds: number;
  /** Largest accepted request body; bigger ones are answered 413 before the app sees them. */
  maxRequestBodyBytes: number;
}

/** Responses that stay open on purpose and send their own heartbeat. */
function isLongLived(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/sync/stream";
}

/**
 * The HTTP listener. Bun closes connections idle for `idleTimeout` seconds (10 by default),
 * which is shorter than the 15 s SSE heartbeat, so the sync stream must opt out of it per request.
 */
export function serveApi(app: App, options: ServeOptions) {
  return Bun.serve({
    port: options.port,
    idleTimeout: options.idleTimeoutSeconds,
    maxRequestBodySize: options.maxRequestBodyBytes,
    // Bun passes the server as the second argument; Hono exposes it as `c.env` (client IP).
    fetch: (request, bunServer) => {
      if (isLongLived(request)) bunServer.timeout(request, 0);
      return app.fetch(request, bunServer);
    },
  });
}
