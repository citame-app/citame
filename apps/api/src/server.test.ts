import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { actor, setupApiTest } from "../test/helpers";
import { serveApi } from "./server";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let server: ReturnType<typeof serveApi>;
let cookie: string;

beforeAll(async () => {
  // Heartbeat (5 s) is longer than the idle timeout (1 s; Bun sweeps idle sockets about every 4 s), the production shape of the bug:
  // Bun's own default is 10 s against a 15 s heartbeat.
  t = await setupApiTest({ dbSuffix: "server", deps: { syncHeartbeatMs: 5000 } });
  await t.reset();
  cookie = (await actor(t, "owner", "owner@example.com")).cookie;
  server = serveApi(t.app, { port: 0, idleTimeoutSeconds: 1, maxRequestBodyBytes: 4096 });
});
afterAll(async () => {
  await server.stop(true);
  await t.close();
});

describe("serveApi", () => {
  test("a long-lived /sync/stream outlives the idle timeout and keeps receiving heartbeats", async () => {
    const res = await fetch(`http://localhost:${server.port}/sync/stream`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const started = Date.now();
    // Idle for longer than the idle timeout: the heartbeat must still arrive.
    while ((text.match(/^: ping$/gm) ?? []).length < 1 && Date.now() - started < 9000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain(": ping");
    expect(Date.now() - started).toBeGreaterThan(4500);
    await reader.cancel();
  }, 15_000);

  test("answers 413 to a body above the global limit", async () => {
    const res = await fetch(`http://localhost:${server.port}/auth-free-echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "x".repeat(10_000) }),
    });
    expect(res.status).toBe(413);
  });

  test("accepts a body under the limit (the request reaches the app)", async () => {
    const res = await fetch(`http://localhost:${server.port}/auth-free-echo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "ok" }),
    });
    expect(res.status).not.toBe(413);
  });
});
