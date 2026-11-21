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
  test("browser API paths are matched without swallowing application routes", () => {
    const { proxy } = proxyWith();
    expect(proxy.matches(new URL("http://web/api/services"))).toBe(true);
    expect(proxy.matches(new URL("http://web/api/auth/sign-in/email"))).toBe(true);
    expect(proxy.matches(new URL("http://web/apiary"))).toBe(false);
    expect(proxy.matches(new URL("http://web/book"))).toBe(false);
  });

  test("the native desktop routes reach the guarded API and other root paths stay private", async () => {
    const { proxy, seen } = proxyWith();
    const paths = [
      "/me",
      "/me/desktop-workspaces",
      "/sync/pull?since=0",
      "/sync/push",
      "/sync/stream",
      "/appointments/desktop-booking",
      "/appointments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/context",
      "/admin/staff/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/date-shifts?from=2026-11-20&to=2026-11-20",
      "/admin/staff/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/date-shifts/preview",
      "/admin/staff/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/working-hours",
      "/admin/notifications/inbox?page=2",
      "/admin/notifications/inbox/archive",
      "/admin/waitlist/desk?page=2",
      "/admin/waitlist/desk/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/cancel",
      "/admin/waitlist/desk/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/accept",
      "/admin/waitlist/desk/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/decline",
      "/admin/waitlist/desk/policy",
      "/admin/commerce/appointments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/imported-price",
      "/admin/commerce/appointments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/imported-settlement",
      "/admin/commerce/appointments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/imported-partial-payment",
      "/admin/commerce/unpaid?from=2026-11-20T00%3A00%3A00Z&to=2026-11-21T00%3A00%3A00Z",
      "/admin/commerce/checkouts",
      "/admin/commerce/capabilities",
      "/admin/inventory/returns",
      "/admin/passes/eligible?checkoutId=01955500-0000-7000-8000-000000000001",
      "/admin/passes/refund-quote",
      "/admin/commerce/payments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/refunds",
      "/admin/commerce/payments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/reconcile",
      "/admin/commerce/refunds/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/execute",
      "/admin/commerce/refunds/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/cancel",
      "/admin/commerce/refunds/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/reconcile",
      "/admin/commerce/checkouts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/commerce/checkouts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/payments",
      "/admin/commerce/checkouts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/prices",
      "/admin/commerce/checkouts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/void",
      "/admin/commerce/cash-sessions",
      "/admin/commerce/cash-sessions/current",
      "/admin/commerce/cash-sessions/adjust",
      "/admin/commerce/cash-sessions/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/close",
      "/admin/reports/summary?from=2026-11-18&to=2026-11-20",
      "/admin/reports/clients?from=2026-11-18&to=2026-11-20",
      "/admin/reports/outcomes?from=2026-11-18&to=2026-11-20&status=cancelled",
      "/admin/reports/outcomes/export?from=2026-11-18&to=2026-11-20&status=no_show",
      "/admin/reviews/requests?page=2&search=A%26B",
      "/admin/reviews/requests/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/email",
      "/admin/reviews?status=pending",
      "/admin/reviews/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/moderation",
      "/admin/reviews/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/reply",
      "/admin/inventory/products?search=repair",
      "/admin/inventory/facets",
      "/admin/inventory/warehouses",
      "/admin/inventory/warehouse-stock?warehouseId=main",
      "/admin/inventory/stock-adjustments/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/transfers/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/suppliers?search=A%26B&page=2",
      "/admin/inventory/suppliers/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/orders?status=partially_received&page=2",
      "/admin/inventory/orders/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/receipts?page=2",
      "/admin/inventory/receipts/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/products/report?lowStock=true",
      "/admin/inventory/products/export?sort=stock_asc",
      "/admin/inventory/movements?kind=receive&search=A%26B&page=2",
      "/admin/inventory/movements/export?kind=receive&search=A%26B",
      "/admin/inventory/products/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/inventory/products/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/package-content",
      "/admin/inventory/products/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/photo/bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      "/intake/requirements?serviceIds=example",
      "/admin/intake-forms",
      "/admin/intake-forms?view=summary",
      "/admin/clients/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/intake?before=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/clients/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/intake/catalog",
      "/admin/clients/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/intake/bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
      "/admin/intake-forms/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
      "/admin/intake-forms/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/publish",
      "/admin/intake-forms/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/archive",
    ];
    for (const path of paths) {
      const request = new Request(`http://web${path}`);
      expect(proxy.matches(new URL(request.url))).toBe(true);
      await proxy.handle(request, "203.0.113.9");
    }
    expect(seen.map((entry) => entry.url)).toEqual(paths.map((path) => `http://api:3000${path}`));
    expect(proxy.matches(new URL("http://web/sync/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/appointments/booksy-context/import"))).toBe(false);
    expect(proxy.matches(new URL("http://web/appointments"))).toBe(false);
    expect(
      proxy.matches(
        new URL("http://web/admin/staff/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/date-shifts/private"),
      ),
    ).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/notifications"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/notifications/inbox/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/waitlist"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/commerce"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/commerce/payments"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/reports"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/reports/summary/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/reports/clients/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/reports/outcomes/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/inventory/products/export/private"))).toBe(
      false,
    );
    expect(proxy.matches(new URL("http://web/admin/inventory/facets/private"))).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/inventory/movements/export/private"))).toBe(
      false,
    );
    expect(
      proxy.matches(
        new URL("http://web/admin/reviews/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/social"),
      ),
    ).toBe(false);
    expect(proxy.matches(new URL("http://web/intake/submissions/example"))).toBe(false);
    expect(
      proxy.matches(new URL("http://web/admin/clients/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa")),
    ).toBe(false);
    expect(
      proxy.matches(
        new URL("http://web/admin/clients/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/intake/invalid"),
      ),
    ).toBe(false);
    expect(proxy.matches(new URL("http://web/admin/intake-forms/invalid"))).toBe(false);
    expect(
      proxy.matches(
        new URL("http://web/admin/intake-forms/aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/responses"),
      ),
    ).toBe(false);
    expect(proxy.matches(new URL("http://web/metrics"))).toBe(false);
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
    expect(proxy.matches(new URL("http://web/.well-known/oauth-protected-resource/mcp"))).toBe(
      true,
    );
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

describe("operational endpoints stay internal", () => {
  test("/api/metrics is never forwarded: the scrape endpoint is not a public route", async () => {
    const { proxy, seen } = proxyWith();
    const response = await proxy.handle(new Request("http://web/api/metrics"), "203.0.113.9");
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  test("the request id travels to the API", async () => {
    const { proxy, seen } = proxyWith();
    await proxy.handle(
      new Request("http://web/api/services", { headers: { "x-request-id": "rid-0123456789" } }),
      "203.0.113.9",
    );
    expect(headersOf(seen[0]).get("x-request-id")).toBe("rid-0123456789");
  });
});
