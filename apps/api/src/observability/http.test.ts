import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createHttpMetrics, currentRequestId, requestContext } from "./http";
import { createLogger } from "./logger";
import { createRegistry } from "./metrics";

function setup() {
  const lines: string[] = [];
  const logger = createLogger({ write: (l) => lines.push(l) });
  const registry = createRegistry();
  const http = createHttpMetrics(registry);
  let seenInHandler: string | undefined;
  const app = new Hono();
  app.use("*", requestContext({ logger, http }));
  app.get("/items/:id", (c) => {
    seenInHandler = currentRequestId();
    return c.json({ ok: true });
  });
  app.get("/boom", () => {
    throw new Error("kaboom for ana@example.com");
  });
  app.onError((error, c) => {
    logger.error("unhandled", { err: error });
    return c.json({ error: "x" }, 500);
  });
  const logs = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { app, registry, logs, seen: () => seenInHandler };
}

describe("request context", () => {
  test("generates a request id, exposes it in the response and to handlers", async () => {
    const { app, seen } = setup();
    const res = await app.request("/items/42");
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen()).toBe(id as string);
  });

  test("keeps a well-formed inbound id so the web tier and the API share one", async () => {
    const { app, logs } = setup();
    const res = await app.request("/items/1", { headers: { "x-request-id": "web-abc_123.XYZ" } });
    expect(res.headers.get("x-request-id")).toBe("web-abc_123.XYZ");
    expect(logs().at(-1)?.requestId).toBe("web-abc_123.XYZ");
  });

  test("replaces malformed inbound ids (log injection, oversized values)", async () => {
    const { app } = setup();
    for (const bad of ["x", "a b c d e f g h", `${"a".repeat(200)}`, 'bad"quote-12345']) {
      const res = await app.request("/items/1", { headers: { "x-request-id": bad } });
      expect(res.headers.get("x-request-id")).not.toBe(bad);
      expect(res.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  test("logs one line per request without the query string, cookies or addresses", async () => {
    const { app, logs } = setup();
    await app.request("/items/42?token=SECRET&email=ana@example.com", {
      headers: { cookie: "session=abc", "x-forwarded-for": "203.0.113.9" },
    });
    const entry = logs().at(-1) as Record<string, unknown>;
    expect(entry).toMatchObject({
      msg: "request",
      method: "GET",
      path: "/items/42",
      route: "/items/:id",
      status: 200,
    });
    expect(typeof entry.durationMs).toBe("number");
    const text = JSON.stringify(entry);
    for (const leaked of ["SECRET", "ana@example.com", "session=abc", "203.0.113.9"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("counts requests and observes latency by route pattern, never by raw path", async () => {
    const { app, registry } = setup();
    await app.request("/items/1");
    await app.request("/items/2");
    await app.request("/nope/ab12");
    const text = registry.render();
    expect(text).toContain(
      'sob_http_requests_total{method="GET",route="/items/:id",status="200"} 2',
    );
    expect(text).toContain(
      'sob_http_requests_total{method="GET",route="unmatched",status="404"} 1',
    );
    expect(text).toContain(
      'sob_http_request_duration_seconds_count{method="GET",route="/items/:id"} 2',
    );
    expect(text).not.toContain("/items/1");
    expect(text).not.toContain("ab12");
  });

  test("server errors are logged with the request id and a scrubbed message", async () => {
    const { app, logs } = setup();
    const res = await app.request("/boom", { headers: { "x-request-id": "req-for-boom-1" } });
    expect(res.status).toBe(500);
    const all = logs();
    expect(all.some((e) => e.msg === "request" && e.status === 500 && e.level === "error")).toBe(
      true,
    );
    expect(JSON.stringify(all)).not.toContain("ana@example.com");
  });
});
