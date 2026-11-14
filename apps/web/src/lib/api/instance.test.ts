import { afterEach, describe, expect, test } from "bun:test";
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
  });
});
