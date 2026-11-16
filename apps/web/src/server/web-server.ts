import { join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { resolveLocale } from "../i18n";
import type { ServerRequestContext } from "../lib/api/request-context";
import { createNonce } from "../lib/csp";
import { parseThemeCookie } from "../lib/theme";
import { visitorAddress } from "./client-address";
import { renderRateLimitedPage } from "./rate-limited-page";
import { runWithRequestContext } from "./request-context";
import { applyWidgetFramePolicy, parseWidgetOrigins } from "./widget-policy";

export interface ProxyLike {
  matches: (url: URL) => boolean;
  handle: (request: Request, socketAddress: string | null) => Promise<Response>;
}

export interface WebServerOptions {
  /** Directory with the built client assets (`dist/client`). */
  clientDir: string;
  /** The TanStack Start server entry's fetch handler. */
  ssr: (request: Request) => Response | Promise<Response>;
  proxy: ProxyLike;
  /** Send HSTS. Only for deployments served over https (the header is ignored over http). */
  hsts?: boolean;
  /**
   * The web server is behind an edge proxy that appends to `X-Forwarded-For` (`WEB_TRUST_PROXY`).
   * Decides how the visitor address handed to SSR (and so to the API) is determined.
   */
  trustProxy?: boolean;
  /** Exact external origins permitted to embed the public read-only widget. Default: same-origin. */
  widgetParentOrigins?: string[];
  /** Access log sink. Receives plain data (no query strings, cookies or addresses). */
  log?: (entry: Record<string, unknown>) => void;
}

/** Baseline hardening for every response. The page CSP is set by the app itself (it needs a nonce). */
const BASELINE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "cross-origin-opener-policy": "same-origin",
};

const SERVER_FN_PREFIX = "/_serverFn/";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const QUIET_PATHS = new Set(["/healthz"]);

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Single-use secrets can travel as a path segment (`/api/auth/reset-password/<token>`): never log them. */
function redactPath(path: string): string {
  return path.replace(/(\/reset-password\/)[^/]+/g, "$1[redacted]");
}

/** A small, dependency-free production server: health, API proxy, static files, then SSR. */
export function createWebServer({
  clientDir,
  ssr,
  proxy,
  hsts = false,
  trustProxy = false,
  widgetParentOrigins = [],
  log,
}: WebServerOptions) {
  const root = normalize(clientDir.endsWith(sep) ? clientDir : clientDir + sep);
  const gzipCache = new Map<string, Uint8Array>();
  const allowedWidgetParents = parseWidgetOrigins(widgetParentOrigins.join(","));

  function acceptsGzip(request: Request): boolean {
    return /\bgzip\b/.test(request.headers.get("accept-encoding") ?? "");
  }

  async function staticFile(request: Request, pathname: string): Promise<Response | null> {
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    const candidate = normalize(join(root, decoded));
    // Path traversal guard: the resolved path must stay inside the client directory.
    if (!candidate.startsWith(root) || candidate === root) return null;
    const file = Bun.file(candidate);
    if (!(await file.exists()) || (file.size === 0 && candidate.endsWith(sep))) return null;
    // Bun.file on a directory reports exists() === true on some platforms; reject by stat.
    const type = file.type.split(";")[0] ?? "";
    const headers = new Headers({
      "content-type": file.type,
      "cache-control": pathname.startsWith("/assets/") ? IMMUTABLE : "public, max-age=3600",
      vary: "Accept-Encoding",
    });
    if (COMPRESSIBLE.test(type) && acceptsGzip(request)) {
      let body = gzipCache.get(candidate);
      if (!body) {
        body = gzipSync(new Uint8Array(await file.arrayBuffer()));
        gzipCache.set(candidate, body);
      }
      headers.set("content-encoding", "gzip");
      return new Response(request.method === "HEAD" ? null : (body as BodyInit), { headers });
    }
    return new Response(request.method === "HEAD" ? null : file, { headers });
  }

  function compress(request: Request, response: Response): Response {
    const type = response.headers.get("content-type") ?? "";
    if (
      !response.body ||
      response.headers.has("content-encoding") ||
      !COMPRESSIBLE.test(type.split(";")[0] ?? "") ||
      !acceptsGzip(request)
    ) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.set("content-encoding", "gzip");
    headers.set("vary", "Accept-Encoding");
    headers.delete("content-length");
    return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  /**
   * The API said 429 while rendering and the render failed because of it: answer 429 with
   * Retry-After (never a 500), and for documents a friendly page in the visitor's language.
   * A render that succeeded despite a limited optional call is left alone.
   */
  function rateLimitedOr(request: Request, response: Response, context: ServerRequestContext) {
    const limit = context.rateLimit;
    if (!limit || response.status < 500) return response;
    const headers = new Headers(response.headers);
    headers.set("retry-after", String(limit.retryAfterSeconds));
    headers.set("cache-control", "private, no-store");
    // TanStack Start's server functions (called by the browser during navigation) speak their own
    // wire format: keep the body, fix the status. Everything else is a page request.
    if (new URL(request.url).pathname.startsWith(SERVER_FN_PREFIX)) {
      return new Response(response.body, { status: 429, headers });
    }
    const cookie = request.headers.get("cookie");
    const nonce = createNonce();
    headers.delete("content-length");
    headers.delete("content-encoding");
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set(
      "content-security-policy",
      `default-src 'none'; style-src 'self' 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    const html = renderRateLimitedPage({
      locale: resolveLocale({ cookie, acceptLanguage: request.headers.get("accept-language") }),
      theme: parseThemeCookie(cookie),
      retryAfterSeconds: limit.retryAfterSeconds,
      nonce,
    });
    void response.body?.cancel();
    return new Response(request.method === "HEAD" ? null : html, { status: 429, headers });
  }

  async function route(
    request: Request,
    url: URL,
    client: { address: string } | null,
  ): Promise<Response> {
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
    }
    if (proxy.matches(url)) {
      return compress(request, await proxy.handle(request, client?.address ?? null));
    }
    const asset = await staticFile(request, url.pathname);
    if (asset) return asset;
    // SSR calls the API from this container: carry the visitor's address so the API rate-limits
    // each visitor on their own instead of lumping every render into the web container's bucket.
    const context: ServerRequestContext = {
      visitorIp: visitorAddress(request, client?.address ?? null, trustProxy),
      requestId: request.headers.get("x-request-id") ?? "",
    };
    const rendered = await runWithRequestContext(context, () => ssr(request));
    return compress(request, rateLimitedOr(request, rendered, context));
  }

  return {
    async fetch(request: Request, client: { address: string } | null): Promise<Response> {
      const started = performance.now();
      const url = new URL(request.url);
      const inbound = request.headers.get("x-request-id");
      const requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
      // One id for the whole visit: SSR server functions and the API proxy both read it from here.
      const headers = new Headers(request.headers);
      headers.set("x-request-id", requestId);
      const tagged = new Request(request, { headers });

      const response = await route(tagged, url, client);
      const out = new Response(response.body, response);
      for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
        if (!out.headers.has(name)) out.headers.set(name, value);
      }
      if (out.status === 200 && (out.headers.get("content-type") ?? "").startsWith("text/html")) {
        applyWidgetFramePolicy(out.headers, url.pathname, allowedWidgetParents);
      }
      if (hsts && !out.headers.has("strict-transport-security")) {
        out.headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
      }
      out.headers.set("x-request-id", requestId);
      if (log && !QUIET_PATHS.has(url.pathname)) {
        log({
          time: new Date().toISOString(),
          level: out.status >= 500 ? "error" : "info",
          msg: "request",
          component: "web",
          requestId,
          method: request.method,
          path: redactPath(url.pathname),
          status: out.status,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        });
      }
      return out;
    },
  };
}
