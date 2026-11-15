export interface ListenerOptions {
  port: number;
  hostname: string;
  /** Seconds a connection may idle before Bun closes it (Bun's default is 10; 0 disables). */
  idleTimeoutSeconds: number;
  /** Largest accepted request body in bytes; bigger ones are answered 413 by Bun. */
  maxRequestBodyBytes: number;
}

export interface Fetcher {
  fetch: (request: Request, client: { address: string } | null) => Promise<Response>;
}

/** The sync event stream, reached through the same-origin proxy. It sends its own heartbeat. */
function isLongLived(request: Request): boolean {
  return request.method === "GET" && new URL(request.url).pathname === "/api/sync/stream";
}

/**
 * The HTTP listener. Bun's default idle timeout (10 s) is shorter than the API's 15 s SSE
 * heartbeat, so the proxied stream opts out per request; everything else keeps the timeout.
 */
export function serveWeb(web: Fetcher, options: ListenerOptions) {
  return Bun.serve({
    port: options.port,
    hostname: options.hostname,
    idleTimeout: options.idleTimeoutSeconds,
    maxRequestBodySize: options.maxRequestBodyBytes,
    fetch: (request, bunServer) => {
      if (isLongLived(request)) bunServer.timeout(request, 0);
      return web.fetch(request, bunServer.requestIP(request));
    },
    error(error) {
      console.error(error);
      return Response.json(
        { error: { code: "internal_error", message: "Internal server error" } },
        { status: 500 },
      );
    },
  });
}
