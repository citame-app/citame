import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installNativeWebApi } from "../../test/native-web";
import { serveWeb } from "./listener";

installNativeWebApi();

let server: ReturnType<typeof serveWeb>;

beforeAll(() => {
  // A stand-in for the web server: /api/sync/stream is a heartbeat stream (the proxied SSE),
  // everything else echoes OK. The heartbeat (5 s) is longer than the idle timeout (1 s).
  const web = {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === "/api/sync/stream") {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("event: change\n\n"));
              await Bun.sleep(5000);
              controller.enqueue(encoder.encode(": ping\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      await request.arrayBuffer();
      return new Response("ok");
    },
  };
  server = serveWeb(web, {
    port: 0,
    hostname: "127.0.0.1",
    idleTimeoutSeconds: 1,
    maxRequestBodyBytes: 4096,
  });
});
afterAll(async () => {
  await server.stop(true);
});

describe("serveWeb", () => {
  test("the proxied sync stream outlives the idle timeout", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/sync/stream`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const started = Date.now();
    while (!text.includes(": ping") && Date.now() - started < 9000) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    expect(text).toContain(": ping");
    await reader.cancel();
  }, 15_000);

  test("answers 413 to an oversized body and serves a small one", async () => {
    const big = await fetch(`http://127.0.0.1:${server.port}/api/x`, {
      method: "POST",
      body: "x".repeat(10_000),
    });
    expect(big.status).toBe(413);
    const small = await fetch(`http://127.0.0.1:${server.port}/api/x`, {
      method: "POST",
      body: "x",
    });
    expect(small.status).toBe(200);
  });
});
