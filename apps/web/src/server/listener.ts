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
  if (request.method !== "GET") return false;
  const { pathname } = new URL(request.url);
  return pathname === "/api/sync/stream" || pathname === "/sync/stream";
}

function drainableSyncResponse(response: Response, shutdown: AbortSignal): Response {
  if (!response.ok || !response.body) return response;
  const upstream = response.body.getReader();
  let finish: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      finish = () => {
        shutdown.removeEventListener("abort", finish);
        controller.close();
        void upstream.cancel().catch(() => {});
      };
      if (shutdown.aborted) finish();
      else shutdown.addEventListener("abort", finish, { once: true });
    },
    async pull(controller) {
      try {
        const chunk = await upstream.read();
        if (shutdown.aborted) return;
        if (chunk.done) {
          shutdown.removeEventListener("abort", finish);
          controller.close();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        if (shutdown.aborted) return;
        shutdown.removeEventListener("abort", finish);
        controller.error(error);
      }
    },
    cancel(reason) {
      shutdown.removeEventListener("abort", finish);
      return upstream.cancel(reason);
    },
  });
  return new Response(body, response);
}

/**
 * The HTTP listener. Bun's default idle timeout (10 s) is shorter than the API's 15 s SSE
 * heartbeat, so the proxied stream opts out per request; everything else keeps the timeout.
 */
export function serveWeb(web: Fetcher, options: ListenerOptions) {
  const syncDrain = new AbortController();
  const server = Bun.serve({
    port: options.port,
    hostname: options.hostname,
    idleTimeout: options.idleTimeoutSeconds,
    maxRequestBodySize: options.maxRequestBodyBytes,
    fetch: (request, bunServer) => {
      const client = bunServer.requestIP(request);
      if (!isLongLived(request)) return web.fetch(request, client);
      bunServer.timeout(request, 0);
      const signal = AbortSignal.any([request.signal, syncDrain.signal]);
      return web
        .fetch(new Request(request, { signal }), client)
        .then((response) => drainableSyncResponse(response, syncDrain.signal));
    },
    error(error) {
      console.error(error);
      return Response.json(
        { error: { code: "internal_error", message: "Internal server error" } },
        { status: 500 },
      );
    },
  });
  return {
    port: server.port,
    hostname: server.hostname,
    stop(force = false) {
      const stopped = server.stop(force);
      // A sync stream otherwise keeps an in-flight request open across every heartbeat.
      syncDrain.abort();
      return stopped;
    },
  };
}
