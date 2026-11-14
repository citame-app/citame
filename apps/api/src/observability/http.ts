import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import { currentRequestId, requestScope } from "./context";
import type { Logger } from "./logger";
import { DEFAULT_LATENCY_BUCKETS, type Registry } from "./metrics";

export { currentRequestId };

/** Inbound ids from the web tier are kept when they are boring enough to log verbatim. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function createHttpMetrics(registry: Registry) {
  return {
    requests: registry.counter("sob_http_requests_total", "HTTP requests handled.", [
      "method",
      "route",
      "status",
    ]),
    duration: registry.histogram(
      "sob_http_request_duration_seconds",
      "HTTP request latency in seconds.",
      ["method", "route"],
      DEFAULT_LATENCY_BUCKETS,
    ),
  };
}

export type HttpMetrics = ReturnType<typeof createHttpMetrics>;

/**
 * The route PATTERN that served the request (`/appointments/:id`), never the raw path: ids in
 * labels would create one series per appointment. Requests nothing matched share one label.
 */
export function routeLabel(c: Context): string {
  const handlers = matchedRoutes(c).filter((r) => r.method !== "ALL" || r.path !== "/*");
  const last = handlers.at(-1);
  return last ? last.path : "unmatched";
}

export interface RequestContextOptions {
  logger: Logger;
  http: HttpMetrics;
  /** Paths whose access log is skipped (probes would drown everything else). */
  quietPaths?: readonly string[];
}

/**
 * Outermost middleware: assigns the request id, makes it available to every log line through
 * AsyncLocalStorage, echoes it as `X-Request-Id`, then writes the access log and the HTTP
 * metrics once the response is known.
 */
export function requestContext({
  logger,
  http,
  quietPaths = [],
}: RequestContextOptions): MiddlewareHandler {
  return async (c, next) => {
    const inbound = c.req.header("x-request-id");
    const requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : Bun.randomUUIDv7();
    c.header("x-request-id", requestId);
    const started = performance.now();
    await requestScope.run({ requestId }, async () => {
      await next();
      const seconds = (performance.now() - started) / 1000;
      const route = routeLabel(c);
      const status = c.res.status;
      http.requests.inc({ method: c.req.method, route, status: String(status) });
      http.duration.observe({ method: c.req.method, route }, seconds);
      const path = new URL(c.req.url).pathname;
      if (quietPaths.includes(path) && status < 400) return;
      const fields = {
        method: c.req.method,
        path,
        route,
        status,
        durationMs: Math.round(seconds * 1000 * 10) / 10,
      };
      if (status >= 500) logger.error("request", fields);
      else logger.info("request", fields);
    });
  };
}
