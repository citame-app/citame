import { createApiClient } from "./client";
import { createEndpoints, type Endpoints } from "./endpoints";
import { currentRequestContext } from "./request-context";

const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** Remembers on the visit being rendered that the API limited it, keeping the longest wait. */
function noteRateLimited(retryAfter: string | null): void {
  const visit = currentRequestContext();
  if (!visit) return;
  const parsed = Number.parseInt(retryAfter ?? "", 10);
  const seconds = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETRY_AFTER_SECONDS;
  visit.rateLimit = {
    retryAfterSeconds: Math.max(seconds, visit.rateLimit?.retryAfterSeconds ?? 0),
  };
}

let browserEndpoints: Endpoints | undefined;

/**
 * Server-side endpoints: talk to the API directly, optionally on behalf of the visitor's cookie.
 * `requestId` is the id the web server gave this visit, so API logs line up with web logs.
 */
export function serverEndpoints(cookie?: string | null, requestId?: string | null): Endpoints {
  const base = (process.env.API_INTERNAL_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return createEndpoints(
    createApiClient({
      restBase: base,
      authBase: base,
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const response = await fetch(...args);
        if (response.status === 429) noteRateLimited(response.headers.get("retry-after"));
        return response;
      }) as typeof fetch,
      headers: (): Record<string, string> => {
        // The visit being rendered: its address makes the API rate-limit this visitor, not the
        // web container, and its request id lines API logs up with web logs.
        const visit = currentRequestContext();
        const id = requestId || visit?.requestId;
        return {
          ...(cookie ? { cookie } : {}),
          ...(id ? { "x-request-id": id } : {}),
          ...(visit?.visitorIp ? { "x-forwarded-for": visit.visitorIp } : {}),
        };
      },
    }),
  );
}

/**
 * The endpoints for the current runtime. In the browser every call goes to the same origin
 * (`/api/*`, forwarded by the web server); during SSR it goes straight to `API_INTERNAL_URL`.
 */
export function api(): Endpoints {
  if (typeof window === "undefined") return serverEndpoints();
  browserEndpoints ??= createEndpoints(createApiClient({ restBase: "/api", authBase: "" }));
  return browserEndpoints;
}
