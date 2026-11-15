import { afterEach, describe, expect, test } from "bun:test";
import { runWithRequestContext } from "../../server/request-context";
import { serverEndpoints } from "./instance";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("serverEndpoints", () => {
  test("forwards the visitor's cookie and the request id to the API", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response(JSON.stringify({ error: { code: "unauthorized", message: "no" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    await serverEndpoints("session=abc", "rid-0123456789")
      .me()
      .catch(() => {});
    expect(seen[0]?.get("cookie")).toBe("session=abc");
    expect(seen[0]?.get("x-request-id")).toBe("rid-0123456789");
  });

  test("omits the header when there is no request id", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await serverEndpoints()
      .me()
      .catch(() => {});
    expect(seen[0]?.has("x-request-id")).toBe(false);
    expect(seen[0]?.has("x-forwarded-for")).toBe(false);
  });

  test("forwards the visitor address of the current SSR request, even for cookie-less calls", async () => {
    const seen: Headers[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await runWithRequestContext({ visitorIp: "198.51.100.7", requestId: "rid-ctx-0123456" }, () =>
      serverEndpoints()
        .me()
        .catch(() => {}),
    );
    expect(seen[0]?.get("x-forwarded-for")).toBe("198.51.100.7");
    expect(seen[0]?.get("x-request-id")).toBe("rid-ctx-0123456");
  });

  test("records a 429 on the visit being rendered, with the API's Retry-After", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "23" },
      })) as unknown as typeof fetch;
    const visit = { visitorIp: "198.51.100.7", requestId: "rid-429-0123456" };
    await runWithRequestContext(visit, () =>
      serverEndpoints()
        .me()
        .catch(() => {}),
    );
    expect(visit).toMatchObject({ rateLimit: { retryAfterSeconds: 23 } });
  });

  test("keeps the longest wait when several calls of one visit are limited", async () => {
    const waits = ["5", "40", "12"];
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": waits.shift() ?? "1" },
      })) as unknown as typeof fetch;
    const visit = { visitorIp: null, requestId: "rid-429-0123456" };
    await runWithRequestContext(visit, async () => {
      for (let i = 0; i < 3; i++)
        await serverEndpoints()
          .me()
          .catch(() => {});
    });
    expect(visit).toMatchObject({ rateLimit: { retryAfterSeconds: 40 } });
  });

  test("other failures do not mark the visit as rate limited", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const visit = { visitorIp: null, requestId: "rid-401-0123456" };
    await runWithRequestContext(visit, () =>
      serverEndpoints()
        .me()
        .catch(() => {}),
    );
    expect("rateLimit" in visit).toBe(false);
  });
});
