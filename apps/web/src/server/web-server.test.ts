import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { installNativeWebApi } from "../../test/native-web";
import { createWebServer } from "./web-server";

installNativeWebApi();

let base: string;
let dir: string;
const proxied: string[] = [];

function server(options: { ssr?: (request: Request) => Response | Promise<Response> } = {}) {
  return createWebServer({
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

describe("api proxy", () => {
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
