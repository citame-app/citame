/**
 * Same-origin BFF: the web server forwards `/api/*` to the Hono API so the browser only talks
 * to its own origin (first-party cookies, no CORS).
 *
 * - `/api/auth/*` is forwarded unchanged (Better Auth is mounted there in the API).
 * - every other `/api/<path>` is forwarded as `/<path>` (the API's REST routes live at the root).
 * - `/mcp` and `/.well-known/*` are forwarded unchanged. The OAuth issuer and the MCP resource
 *   are public URLs on this origin (ADR 0009), and RFC 8414 / RFC 9728 put their metadata under
 *   the origin's `/.well-known/`, so the browser-facing origin has to serve them.
 *
 * TRUST_PROXY: the API reads the client IP from the LAST `X-Forwarded-For` entry when it runs with
 * `TRUST_PROXY=true`. This proxy is that single trusted hop, so it REPLACES the header with one
 * entry: the address it determined for the visitor. Inbound `X-Forwarded-For` values are never
 * passed through, so a visitor cannot choose the identity the API rate-limits. When the web
 * server itself sits behind an edge proxy you operate, set `WEB_TRUST_PROXY=true` and the visitor
 * is the last inbound entry instead of the socket address.
 */

const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "forwarded",
];

export interface ProxyOptions {
  /** Internal URL of the Hono API, e.g. `http://api:3000`. */
  apiUrl: string;
  /** The web server is behind an edge proxy that appends to `X-Forwarded-For`. */
  trustProxy: boolean;
  fetch?: typeof fetch;
}

export function createProxy({ apiUrl, trustProxy, fetch: doFetch = fetch }: ProxyOptions) {
  const base = apiUrl.replace(/\/+$/, "");

  function isPassthrough(url: URL): boolean {
    return (
      url.pathname === "/mcp" ||
      url.pathname.startsWith("/mcp/") ||
      url.pathname.startsWith("/.well-known/")
    );
  }

  function matches(url: URL): boolean {
    return url.pathname === "/api" || url.pathname.startsWith("/api/") || isPassthrough(url);
  }

  function targetFor(url: URL): string {
    if (isPassthrough(url)) return `${base}${url.pathname}${url.search}`;
    const path = url.pathname.slice("/api".length) || "/";
    const upstreamPath = path.startsWith("/auth/") || path === "/auth" ? `/api${path}` : path;
    return `${base}${upstreamPath}${url.search}`;
  }

  function visitorAddress(request: Request, socketAddress: string | null): string | null {
    if (trustProxy) {
      const last = request.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
      if (last) return last;
    }
    return socketAddress;
  }

  async function handle(request: Request, socketAddress: string | null): Promise<Response> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    // The API is on the internal network: skip compression so the body streams back untouched.
    headers.set("accept-encoding", "identity");
    const address = visitorAddress(request, socketAddress);
    if (address) headers.set("x-forwarded-for", address);
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", url.protocol.replace(":", ""));

    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    try {
      const upstream = await doFetch(targetFor(url), {
        method: request.method,
        headers,
        body: hasBody ? request.body : undefined,
        redirect: "manual",
        // Required by the fetch spec when streaming a request body.
        ...(hasBody ? { duplex: "half" } : {}),
      } as RequestInit);
      const responseHeaders = new Headers(upstream.headers);
      responseHeaders.delete("content-length");
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("transfer-encoding");
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error("API proxy failed", error);
      return Response.json(
        { error: { code: "internal_error", message: "The API is unavailable" } },
        { status: 502 },
      );
    }
  }

  return { matches, handle };
}
