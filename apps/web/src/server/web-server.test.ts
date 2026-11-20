import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { installNativeWebApi } from "../../test/native-web";
import { currentRequestContext } from "../lib/api/request-context";
import { createWebServer } from "./web-server";

installNativeWebApi();

let base: string;
let dir: string;
const proxied: string[] = [];

function server(
  options: { ssr?: (request: Request) => Response | Promise<Response>; hsts?: boolean } = {},
) {
  return createWebServer({
    hsts: options.hsts,
    clientDir: dir,
    ssr:
      options.ssr ??
      (() =>
        new Response("<html>ssr</html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })),
    proxy: {
      matches: (url) => url.pathname.startsWith("/api/"),
      handle: async (request, address) => {
        proxied.push(`${new URL(request.url).pathname}|${address}`);
        return new Response('{"proxied":true}', {
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
}

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "web-client-"));
  dir = join(base, "client");
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(join(dir, "assets", "app-abc123.js"), "console.log('hello'.repeat(500));");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(base, "secret.txt"), "outside the public directory");
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

const get = (handler: ReturnType<typeof server>, path: string, init: RequestInit = {}) =>
  handler.fetch(new Request(`http://web${path}`, init), { address: "203.0.113.9" });

describe("health", () => {
  test("/healthz answers ok without touching the API or SSR", async () => {
    const response = await get(
      server({
        ssr: () => {
          throw new Error("must not render");
        },
      }),
      "/healthz",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("ssr request context", () => {
  const seen = (options: { trustProxy?: boolean } = {}) => {
    const contexts: Array<ReturnType<typeof currentRequestContext>> = [];
    const handler = createWebServer({
      clientDir: dir,
      trustProxy: options.trustProxy,
      ssr: () => {
        contexts.push(currentRequestContext());
        return new Response("ok");
      },
      proxy: { matches: () => false, handle: async () => new Response("") },
    });
    return { handler, contexts };
  };

  test("SSR runs with the socket address as the visitor, ignoring a client-supplied XFF", async () => {
    const { handler, contexts } = seen();
    await get(handler, "/", { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(contexts[0]?.visitorIp).toBe("203.0.113.9");
    expect(contexts[0]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("behind a trusted edge proxy the visitor is the last XFF entry", async () => {
    const { handler, contexts } = seen({ trustProxy: true });
    await get(handler, "/", { headers: { "x-forwarded-for": "6.6.6.6, 198.51.100.4" } });
    expect(contexts[0]?.visitorIp).toBe("198.51.100.4");
  });

  test("concurrent requests keep separate contexts", async () => {
    const { handler, contexts } = seen({ trustProxy: true });
    await Promise.all(
      ["198.51.100.1", "198.51.100.2", "198.51.100.3"].map((ip) =>
        get(handler, "/", { headers: { "x-forwarded-for": ip } }),
      ),
    );
    expect(contexts.map((c) => c?.visitorIp).sort()).toEqual([
      "198.51.100.1",
      "198.51.100.2",
      "198.51.100.3",
    ]);
  });
});

describe("rate-limited renders", () => {
  const html = { "content-type": "text/html; charset=utf-8" };
  const limited = (retryAfterSeconds: number, status = 500, body = "<html>boom</html>") =>
    createWebServer({
      clientDir: dir,
      ssr: () => {
        const visit = currentRequestContext();
        if (visit) visit.rateLimit = { retryAfterSeconds };
        return new Response(body, { status, headers: html });
      },
      proxy: { matches: () => false, handle: async () => new Response("") },
    });

  test("an SSR failure caused by the API's 429 becomes a 429 page with Retry-After", async () => {
    const response = await get(limited(17), "/book");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Too many attempts");
    expect(body).not.toContain("boom");
  });

  test("the notice follows the visitor's language: cookie first, then Accept-Language", async () => {
    const byCookie = await get(limited(9), "/book", { headers: { cookie: "sob_locale=es-AR" } });
    expect(await byCookie.text()).toContain("Demasiados intentos");
    const byHeader = await get(limited(9), "/book", {
      headers: { "accept-language": "es-AR,es;q=0.9" },
    });
    expect(await byHeader.text()).toContain("Demasiados intentos");
  });

  test("the notice carries a nonce-based CSP that matches its inline style", async () => {
    const response = await get(limited(9), "/book");
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = /style-src 'self' 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(await response.text()).toContain(`<style nonce="${nonce}">`);
  });

  test("a page that rendered fine keeps its status even if an optional call was limited", async () => {
    const response = await get(limited(9, 200, "<html>fine</html>"), "/book");
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.text()).toBe("<html>fine</html>");
  });

  test("a failure that is not rate limiting stays a 500", async () => {
    const handler = createWebServer({
      clientDir: dir,
      ssr: () => new Response("<html>boom</html>", { status: 500, headers: html }),
      proxy: { matches: () => false, handle: async () => new Response("") },
    });
    const response = await get(handler, "/book");
    expect(response.status).toBe(500);
    expect(response.headers.get("retry-after")).toBeNull();
  });

  test("non-document responses (server functions) keep their body but get 429 and Retry-After", async () => {
    const handler = createWebServer({
      clientDir: dir,
      ssr: () => {
        const visit = currentRequestContext();
        if (visit) visit.rateLimit = { retryAfterSeconds: 4 };
        return Response.json({ error: "x" }, { status: 500 });
      },
      proxy: { matches: () => false, handle: async () => new Response("") },
    });
    const response = await get(handler, "/_serverFn/abc");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("4");
    expect(await response.json()).toEqual({ error: "x" });
  });

  test("a page request answered with a bare JSON 500 (unhandled SSR error) still gets the notice", async () => {
    const handler = createWebServer({
      clientDir: dir,
      ssr: () => {
        const visit = currentRequestContext();
        if (visit) visit.rateLimit = { retryAfterSeconds: 6 };
        return Response.json(
          { status: 500, unhandled: true, message: "HTTPError" },
          { status: 500 },
        );
      },
      proxy: { matches: () => false, handle: async () => new Response("") },
    });
    const response = await get(handler, "/account");
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("Too many attempts");
  });

  test("two visitors rendering at once never see each other's rate-limit state", async () => {
    const handler = createWebServer({
      clientDir: dir,
      trustProxy: true,
      ssr: async () => {
        const visit = currentRequestContext();
        await Bun.sleep(5);
        if (visit?.visitorIp === "198.51.100.1" && visit)
          visit.rateLimit = { retryAfterSeconds: 3 };
        return new Response("ok", { status: visit?.rateLimit ? 500 : 200, headers: html });
      },
      proxy: { matches: () => false, handle: async () => new Response("") },
    });
    const [a, b] = await Promise.all(
      ["198.51.100.1", "198.51.100.2"].map((ip) =>
        get(handler, "/book", { headers: { "x-forwarded-for": ip } }),
      ),
    );
    expect([a?.status, b?.status]).toEqual([429, 200]);
  });
});

describe("api proxy", () => {
  test("SSE bypasses gzip and delivers the first event before the stream closes", async () => {
    let end: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        end = controller;
        controller.enqueue(new TextEncoder().encode('event: change\ndata: {"seq":1}\n\n'));
      },
    });
    const handler = createWebServer({
      clientDir: dir,
      ssr: () => new Response(""),
      proxy: {
        matches: () => true,
        handle: async () =>
          new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      },
    });
    const response = await get(handler, "/api/sync/stream", {
      headers: { "accept-encoding": "gzip, br" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    const reader = response.body?.getReader();
    try {
      const event = await reader?.read();
      expect(new TextDecoder().decode(event?.value)).toContain('data: {"seq":1}');
    } finally {
      end?.close();
      await reader?.cancel();
    }
  });
  test("hands /api requests to the proxy with the socket address", async () => {
    const response = await get(server(), "/api/services");
    expect(await response.json()).toEqual({ proxied: true });
    expect(proxied).toContain("/api/services|203.0.113.9");
  });
});

describe("static files", () => {
  test("serves fingerprinted assets with a one-year immutable cache", async () => {
    const response = await get(server(), "/assets/app-abc123.js");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  test("serves other public files with a short revalidating cache", async () => {
    const response = await get(server(), "/favicon.svg");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  test("compresses text assets for clients that accept gzip", async () => {
    const response = await get(server(), "/assets/app-abc123.js", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toContain("hello");
  });

  test("never serves files outside the client directory", async () => {
    for (const path of [
      "/../secret.txt",
      "/assets/../../etc/passwd",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/x",
    ]) {
      const response = await get(server(), path);
      expect(await response.text()).toBe("<html>ssr</html>");
    }
  });

  test("directories and missing files fall through to the app", async () => {
    expect(await (await get(server(), "/assets")).text()).toBe("<html>ssr</html>");
    expect(await (await get(server(), "/assets/missing.js")).text()).toBe("<html>ssr</html>");
  });
});

describe("rendering", () => {
  test("everything else is rendered by the app", async () => {
    const response = await get(server(), "/book");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<html>ssr</html>");
  });

  test("HTML is compressed when the client accepts gzip", async () => {
    const response = await get(server(), "/book", { headers: { "accept-encoding": "gzip, br" } });
    expect(response.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString()).toBe(
      "<html>ssr</html>",
    );
  });

  test("POSTs are never answered from static files", async () => {
    const response = await get(server(), "/favicon.svg", { method: "POST", body: "x" });
    expect(await response.text()).toBe("<html>ssr</html>");
  });
});

describe("security headers", () => {
  test("every response, whichever path produced it, carries the baseline headers", async () => {
    for (const path of ["/book", "/favicon.svg", "/api/services", "/healthz"]) {
      const response = await get(server(), path);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(response.headers.get("strict-transport-security")).toBeNull();
    }
  });

  test("HSTS is added only when the deployment is https", async () => {
    const response = await get(server({ hsts: true }), "/book");
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  test("headers set by the app (its CSP) are kept, not overwritten", async () => {
    const response = await get(
      server({
        ssr: () =>
          new Response("x", {
            headers: {
              "content-type": "text/html",
              "content-security-policy": "default-src 'self'",
            },
          }),
      }),
      "/book",
    );
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });
});

describe("request ids and access log", () => {
  function logged() {
    const lines: Record<string, unknown>[] = [];
    const handler = createWebServer({
      clientDir: dir,
      ssr: (request) =>
        new Response(request.headers.get("x-request-id") ?? "none", {
          headers: { "content-type": "text/plain" },
        }),
      proxy: {
        matches: (url) => url.pathname.startsWith("/api/"),
        handle: async (request) =>
          new Response(request.headers.get("x-request-id") ?? "none", {
            headers: { "content-type": "text/plain" },
          }),
      },
      log: (entry) => lines.push(entry),
    });
    return { handler, lines };
  }

  test("a request id is generated, passed to SSR and the proxy, and returned", async () => {
    const { handler } = logged();
    const page = await get(handler, "/book");
    const id = page.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await page.text()).toBe(id as string);
    const api = await get(handler, "/api/services");
    expect(await api.text()).toBe(api.headers.get("x-request-id") as string);
  });

  test("a well-formed inbound id from the edge proxy is kept", async () => {
    const { handler } = logged();
    const response = await get(handler, "/book", {
      headers: { "x-request-id": "edge-0123456789" },
    });
    expect(response.headers.get("x-request-id")).toBe("edge-0123456789");
    expect(await response.text()).toBe("edge-0123456789");
  });

  test("logs one JSON-able line per request, without query strings or cookies", async () => {
    const { handler, lines } = logged();
    await get(handler, "/notifications/opt-out?token=SECRET", { headers: { cookie: "a=b" } });
    const entry = lines.at(-1) ?? {};
    expect(entry).toMatchObject({
      msg: "request",
      method: "GET",
      path: "/notifications/opt-out",
      status: 200,
    });
    expect(JSON.stringify(entry)).not.toContain("SECRET");
    expect(JSON.stringify(entry)).not.toContain("a=b");
  });

  test("never logs a single-use token carried in the path", async () => {
    const { handler, lines } = logged();
    await get(handler, "/api/auth/reset-password/SECRETTOKEN123?callbackURL=%2Fx");
    expect(lines[0]?.path).toBe("/api/auth/reset-password/[redacted]");
    expect(JSON.stringify(lines)).not.toContain("SECRETTOKEN123");
  });

  test("probes are not logged", async () => {
    const { handler, lines } = logged();
    await get(handler, "/healthz");
    expect(lines).toHaveLength(0);
  });
});
