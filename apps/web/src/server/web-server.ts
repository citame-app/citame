import { join, normalize, sep } from "node:path";
import { gzipSync } from "node:zlib";

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
}

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/;
const IMMUTABLE = "public, max-age=31536000, immutable";

/** A small, dependency-free production server: health, API proxy, static files, then SSR. */
export function createWebServer({ clientDir, ssr, proxy }: WebServerOptions) {
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

  return {
    async fetch(request: Request, client: { address: string } | null): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ status: "ok" }, { headers: { "cache-control": "no-store" } });
      }
      if (proxy.matches(url)) {
        return compress(request, await proxy.handle(request, client?.address ?? null));
      }
      const asset = await staticFile(request, url.pathname);
      if (asset) return asset;
      return compress(request, await ssr(request));
    },
  };
}
