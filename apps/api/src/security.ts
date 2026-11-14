import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { errorBody } from "./http";

/**
 * Response headers for a JSON API: nothing it returns is ever rendered, framed or sniffed, so
 * the CSP forbids everything. HSTS only goes out once the deployment is https (the header is
 * ignored over http, and sending it from a misconfigured http origin would be misleading).
 */
export function securityHeaders(options: { hsts: boolean }): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set("x-content-type-options", "nosniff");
    c.res.headers.set("referrer-policy", "no-referrer");
    c.res.headers.set(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    c.res.headers.set("x-frame-options", "DENY");
    c.res.headers.set(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    );
    if (options.hsts) {
      c.res.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
  };
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Defence in depth on top of SameSite=Lax cookies: a browser that sends an `Origin` header
 * which is not one of ours is refused on mutating requests. Requests without `Origin`
 * (the desktop client, curl, server-to-server) are not browsers and are unaffected; their
 * authentication is not ambient, so there is nothing to forge. Better Auth runs its own
 * check for `/api/auth/*`; the public OAuth/MCP endpoints are cross-origin by design.
 */
export function originCheck(trusted: readonly string[]): MiddlewareHandler {
  const allowed = new Set(trusted.map((origin) => origin.replace(/\/+$/, "")));
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && UNSAFE.has(c.req.method) && !allowed.has(origin.replace(/\/+$/, ""))) {
      return c.json(errorBody("forbidden", "Cross-origin request refused"), 403);
    }
    await next();
  };
}

/** Constant-time bearer comparison for the `/metrics` scrape token. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const presented = header?.match(/^Bearer\s+(.+)$/i)?.[1] ?? "";
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}
