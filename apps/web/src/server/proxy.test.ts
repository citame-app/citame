import { describe, expect, test } from "bun:test";
import { installNativeWebApi } from "../../test/native-web";
import { createProxy } from "./proxy";

installNativeWebApi();

interface Seen {
  url: string;
  init: RequestInit & { duplex?: string };
}

function proxyWith(
  options: { trustProxy?: boolean; upstream?: (seen: Seen) => Response | Promise<Response> } = {},
) {
  const seen: Seen[] = [];
  const proxy = createProxy({
    apiUrl: "http://api:3000",
    trustProxy: options.trustProxy ?? false,
    fetch: (async (url: string, init: Seen["init"]) => {
      const call = { url, init };
      seen.push(call);
      return options.upstream ? options.upstream(call) : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { proxy, seen };
}

const headersOf = (seen: Seen | undefined) => new Headers(seen?.init.headers);

describe("route mapping", () => {
  test("only /api paths are handled", () => {
    const { proxy } = proxyWith();
    expect(proxy.matches(new URL("http://web/api/services"))).toBe(true);
    expect(proxy.matches(new URL("http://web/api/auth/sign-in/email"))).toBe(true);
    expect(proxy.matches(new URL("http://web/apiary"))).toBe(false);
    expect(proxy.matches(new URL("http://web/book"))).toBe(false);
  });

  test("REST paths lose the /api prefix, auth paths keep it", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(new Request("http://web/api/services?active=1"), "203.0.113.9");
    await proxy.handle(
      new Request("http://web/api/auth/sign-in/email", { method: "POST", body: "{}" }),
      "203.0.113.9",
    );
    expect(seen.map((s) => s.url)).toEqual([
      "http://api:3000/services?active=1",
      "http://api:3000/api/auth/sign-in/email",
    ]);
  });
});

describe("OAuth discovery and MCP routes", () => {
  test("/mcp and /.well-known/* are handled by the proxy", () => {
    const { proxy } = proxyWith();
    expect(proxy.matches(new URL("http://web/mcp"))).toBe(true);
    expect(proxy.matches(new URL("http://web/.well-known/oauth-protected-resource/mcp"))).toBe(true);
    expect(
      proxy.matches(new URL("http://web/.well-known/oauth-authorization-server/api/auth")),
    ).toBe(true);
    expect(proxy.matches(new URL("http://web/mcpx"))).toBe(false);
    expect(proxy.matches(new URL("http://web/.well-known-other"))).toBe(false);
    expect(proxy.matches(new URL("http://web/consent"))).toBe(false);
  });

  test("they reach the API at the same path, query included", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(
      new Request("http://web/mcp", { method: "POST", body: "{}" }),
      "203.0.113.9",
    );
    await proxy.handle(
      new Request("http://web/.well-known/oauth-protected-resource/mcp?x=1"),
      "203.0.113.9",
    );
    expect(seen.map((s) => s.url)).toEqual([
      "http://api:3000/mcp",
      "http://api:3000/.well-known/oauth-protected-resource/mcp?x=1",
    ]);
  });
});

describe("request forwarding", () => {
  test("forwards method, body, cookie, origin and content type", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(
      new Request("http://web/api/appointments", {
        method: "POST",
        body: '{"a":1}',
        headers: {
          cookie: "sob.session_token=abc",
          origin: "http://web",
          "content-type": "application/json",
        },
      }),
      "203.0.113.9",
    );
    const call = seen[0];
    expect(call?.init.method).toBe("POST");
    expect(headersOf(call).get("cookie")).toBe("sob.session_token=abc");
    expect(headersOf(call).get("origin")).toBe("http://web");
    expect(headersOf(call).get("content-type")).toBe("application/json");
    expect(await new Response(call?.init.body as BodyInit).text()).toBe('{"a":1}');
  });

  test("does not forward hop-by-hop headers or the original host", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(
      new Request("http://web/api/services", {
        headers: { connection: "keep-alive", "transfer-encoding": "chunked", "keep-alive": "1" },
      }),
      "203.0.113.9",
    );
    const headers = headersOf(seen[0]);
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("keep-alive")).toBeNull();
    expect(headers.get("transfer-encoding")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });

  test("never follows upstream redirects", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(new Request("http://web/api/services"), "203.0.113.9");
    expect(seen[0]?.init.redirect).toBe("manual");
  });
});

describe("forwarded headers and TRUST_PROXY semantics", () => {
  test("the API sees the connecting address as the LAST X-Forwarded-For entry", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(
      // A visitor trying to spoof their address must not influence what the API reads.
      new Request("http://web/api/services", {
        headers: { "x-forwarded-for": "1.1.1.1, 2.2.2.2" },
      }),
      "203.0.113.9",
    );
    expect(headersOf(seen[0]).get("x-forwarded-for")).toBe("203.0.113.9");
  });

  test("behind a trusted edge proxy the visitor is the last inbound X-Forwarded-For entry", async () => {
    const { proxy, seen } = proxyWith({ trustProxy: true });
    await proxy.handle(
      new Request("http://web/api/services", {
        headers: { "x-forwarded-for": "9.9.9.9, 198.51.100.4" },
      }),
      "10.0.0.2",
    );
    expect(headersOf(seen[0]).get("x-forwarded-for")).toBe("198.51.100.4");
  });

  test("trusting the proxy without a header falls back to the socket address", async () => {
    const { proxy, seen } = proxyWith({ trustProxy: true });
    await proxy.handle(new Request("http://web/api/services"), "10.0.0.2");
    expect(headersOf(seen[0]).get("x-forwarded-for")).toBe("10.0.0.2");
  });

  test("sets forwarded host and protocol from the public request", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(new Request("https://salon.example/api/services"), "203.0.113.9");
    expect(headersOf(seen[0]).get("x-forwarded-host")).toBe("salon.example");
    expect(headersOf(seen[0]).get("x-forwarded-proto")).toBe("https");
  });

  test("an unknown client address sends no X-Forwarded-For at all", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(new Request("http://web/api/services"), null);
    expect(headersOf(seen[0]).get("x-forwarded-for")).toBeNull();
  });
});

describe("response forwarding", () => {
  test("keeps status, body and every Set-Cookie header", async () => {
    const { proxy } = proxyWith({
      upstream: () => {
        const headers = new Headers({ "content-type": "application/json", "retry-after": "30" });
        headers.append("set-cookie", "a=1; HttpOnly");
        headers.append("set-cookie", "b=2; HttpOnly");
        return new Response('{"error":{"code":"rate_limited","message":"slow down"}}', {
          status: 429,
          headers,
        });
      },
    });
    const response = await proxy.handle(new Request("http://web/api/services"), "203.0.113.9");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(response.headers.getSetCookie()).toEqual(["a=1; HttpOnly", "b=2; HttpOnly"]);
    expect(await response.json()).toEqual({
      error: { code: "rate_limited", message: "slow down" },
    });
  });

  test("answers 502 with the stable error envelope when the API is unreachable", async () => {
    const { proxy } = proxyWith({
      upstream: () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    });
    const response = await proxy.handle(new Request("http://web/api/services"), "203.0.113.9");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: { code: "internal_error", message: "The API is unavailable" },
    });
  });
});
