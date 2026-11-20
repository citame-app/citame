import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { installNativeWebApi } from "../../test/native-web";
import { serveWeb } from "./listener";
import { createProxy } from "./proxy";

installNativeWebApi();

let server: ReturnType<typeof serveWeb>;

beforeAll(() => {
  // A stand-in for the web server: /api/sync/stream is a heartbeat stream (the proxied SSE),
  // everything else echoes OK. The heartbeat (5 s) is longer than the idle timeout (1 s).
  const web = {
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname.endsWith("/sync/stream")) {
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
  test.each(["/api/sync/stream", "/sync/stream"])(
    "the proxied sync stream %s outlives the idle timeout",
    async (path) => {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`);
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
    },
    15_000,
  );

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

  test("an upstream idle timeout permits recovery, established streams and progressing uploads", async () => {
    const release = Promise.withResolvers<void>();
    let available = false;
    const requests: string[] = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url);
        requests.push(`${request.method} ${pathname}`);
        if (!available) {
          await release.promise;
          return new Response("late");
        }
        if (request.method === "POST") return new Response(String((await request.text()).length));
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(encoder.encode("event: change\n\n"));
              await Bun.sleep(350);
              controller.enqueue(encoder.encode(": ping\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = createProxy({
      apiUrl: upstream.url.origin,
      trustProxy: false,
      upstreamIdleTimeoutMs: 200,
    });
    const edge = serveWeb(
      { fetch: (request, client) => proxy.handle(request, client?.address ?? null) },
      { port: 0, hostname: "127.0.0.1", idleTimeoutSeconds: 5, maxRequestBodyBytes: 4096 },
    );
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      for (const [path, options] of [
        ["/sync/stream", {}],
        ["/api/write", { method: "POST", body: "synthetic edit" }],
      ] as const) {
        const response = await fetch(base + path, {
          ...options,
          signal: AbortSignal.timeout(2000),
        });
        expect(response.status).toBe(504);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
      }
      expect(requests).toEqual(["GET /sync/stream", "POST /write"]);
      available = true;
      release.resolve();
      const stream = await fetch(base + "/sync/stream", { signal: AbortSignal.timeout(2000) });
      expect(stream.status).toBe(200);
      expect(await stream.text()).toBe("event: change\n\n: ping\n\n");
      const chunk = new Uint8Array(256).fill(65);
      const write = await fetch(base + "/api/write", {
        method: "POST",
        body: new ReadableStream({
          async start(controller) {
            for (let index = 0; index < 4; index++) {
              if (index > 0) await Bun.sleep(100);
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        signal: AbortSignal.timeout(2000),
      });
      expect(write.status).toBe(200);
      expect(await write.text()).toBe("1024");
    } finally {
      release.resolve();
      await Promise.all([edge.stop(true), upstream.stop(true)]);
    }
  }, 5000);

  test("shutdown releases both proxied sync streams and lets a pending write finish", async () => {
    const writeStarted = Promise.withResolvers<void>();
    const finishWrite = Promise.withResolvers<void>();
    const syncClosed = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (request.method === "POST") {
          await request.text();
          writeStarted.resolve();
          await finishWrite.promise;
          return new Response("saved");
        }
        const closed = syncClosed[Number(new URL(request.url).searchParams.get("stream"))]!;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: change\n\n"));
            },
            cancel() {
              closed.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = createProxy({ apiUrl: upstream.url.origin, trustProxy: false });
    const edge = serveWeb(
      { fetch: (request, client) => proxy.handle(request, client?.address ?? null) },
      { port: 0, hostname: "127.0.0.1", idleTimeoutSeconds: 5, maxRequestBodyBytes: 4096 },
    );
    const base = `http://127.0.0.1:${edge.port}`;
    try {
      const readers = await Promise.all(
        ["/sync/stream", "/api/sync/stream"].map(async (path, index) => {
          const response = await fetch(`${base}${path}?stream=${index}`);
          const reader = response.body!.getReader();
          expect(new TextDecoder().decode((await reader.read()).value)).toContain("event: change");
          return reader;
        }),
      );
      const write = fetch(`${base}/api/write`, { method: "POST", body: "synthetic edit" });
      await writeStarted.promise;
      const stopped = edge.stop();
      const downstreamClosed = await Promise.all(
        readers.map(async (reader) => (await reader.read()).done),
      );
      expect(downstreamClosed).toEqual([true, true]);
      await Promise.all(syncClosed.map(({ promise }) => promise));
      finishWrite.resolve();
      expect(await (await write).text()).toBe("saved");
      await stopped;
    } finally {
      finishWrite.resolve();
      await Promise.all([edge.stop(true), upstream.stop(true)]);
    }
  }, 4000);
});
