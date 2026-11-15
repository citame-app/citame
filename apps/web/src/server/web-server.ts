import { join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { visitorAddress } from "./client-address";
import { runWithRequestContext } from "./request-context";

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

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;
const QUIET_PATHS = new Set(["/healthz"]);

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** A small, dependency-free production server: health, API proxy, static files, then SSR. */
export function createWebServer({
  clientDir,
  ssr,
  proxy,
  hsts = false,
  trustProxy = false,
  log,
}: WebServerOptions) {
  const root = normalize(clientDir.endsWith(sep) ? clientDir : clientDir + sep);
  const gzipCache = new Map<string, Uint8Array>();

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
    const context = {
      visitorIp: visitorAddress(request, client?.address ?? null, trustProxy),
      requestId: request.headers.get("x-request-id") ?? "",
    };
    return compress(request, await runWithRequestContext(context, () => ssr(request)));
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
          path: url.pathname,
          status: out.status,
          durationMs: Math.round((performance.now() - started) * 10) / 10,
        });
      }
      return out;
    },
  };
}
