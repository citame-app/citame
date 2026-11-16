import { expect, test } from "bun:test";
import { installNativeWebApi } from "../../test/native-web";
import { createWebServer } from "./web-server";

installNativeWebApi();
test("only a successful public widget document can opt into configured embedding", async () => {
  const csp = "script-src 'self' 'nonce-live'; frame-ancestors 'none'; base-uri 'self'";
  const make = (options: { widgetParentOrigins?: string[]; status?: number; type?: string } = {}) =>
    createWebServer({
      clientDir: "/__sob_widget_test_no_assets__",
      widgetParentOrigins: options.widgetParentOrigins ?? ["https://salon.example"],
      ssr: () =>
        new Response("<html>widget</html>", {
          status: options.status ?? 200,
          headers: { "content-type": options.type ?? "text/html", "content-security-policy": csp },
        }),
      proxy: {
        matches: (url) => url.pathname.startsWith("/api/"),
        handle: async () => Response.json({ public: true }),
      },
    });
  const get = (server: ReturnType<typeof make>, path: string) =>
    server.fetch(new Request(`https://booking.example${path}`), null);
  const handler = make();
  const widget = await get(handler, "/widget");
  expect(widget.headers.get("x-frame-options")).toBeNull();
  expect(widget.headers.get("content-security-policy")).toBe(
    "script-src 'self' 'nonce-live'; base-uri 'self'; frame-ancestors 'self' https://salon.example",
  );
  for (const path of ["/book", "/admin/reputation", "/widget/other", "/api/appointments"])
    expect((await get(handler, path)).headers.get("x-frame-options")).toBe("DENY");
  expect((await get(make({ status: 500 }), "/widget")).headers.get("x-frame-options")).toBe("DENY");
  expect(
    (await get(make({ type: "application/json" }), "/widget")).headers.get("x-frame-options"),
  ).toBe("DENY");
  expect(() => make({ widgetParentOrigins: ["https://*.example.com"] })).toThrow();
});
