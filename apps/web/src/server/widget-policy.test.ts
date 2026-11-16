import { expect, test } from "bun:test";
import { applyWidgetFramePolicy, parseWidgetOrigins } from "./widget-policy";

test("widget framing allows only exact configured origins and keeps the rest of CSP unchanged", () => {
  const allowed = parseWidgetOrigins(
    " https://salon.example, http://localhost:4274,https://salon.example/ ",
  );
  expect(allowed).toEqual(["https://salon.example", "http://localhost:4274"]);
  const headers = new Headers({
    "x-frame-options": "DENY",
    "content-security-policy":
      "script-src 'self' 'nonce-abc'; frame-ancestors 'none'; form-action 'self' https://sis.redsys.es",
  });
  applyWidgetFramePolicy(headers, "/widget", allowed);
  expect(headers.has("x-frame-options")).toBe(false);
  expect(headers.get("content-security-policy")).toBe(
    "script-src 'self' 'nonce-abc'; form-action 'self' https://sis.redsys.es; frame-ancestors 'self' https://salon.example http://localhost:4274",
  );
  for (const path of ["/book", "/admin", "/widget/other", "/api/appointments", "/Widget"]) {
    const protectedHeaders = new Headers({
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    });
    applyWidgetFramePolicy(protectedHeaders, path, allowed);
    expect(protectedHeaders.get("x-frame-options")).toBe("DENY");
    expect(protectedHeaders.get("content-security-policy")).toBe("frame-ancestors 'none'");
  }
});
test("unconfigured widgets stay same-origin; unsafe wildcard, path and credential configuration fails closed", () => {
  const headers = new Headers({
    "x-frame-options": "DENY",
    "content-security-policy": "frame-ancestors 'none'",
  });
  applyWidgetFramePolicy(headers, "/widget", parseWidgetOrigins());
  expect(headers.get("x-frame-options")).toBe("SAMEORIGIN");
  expect(headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  for (const raw of [
    "*",
    "https://*.example.com",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com?x=y",
    "data:text/html,test",
    "https://exam\nple.com",
  ])
    expect(() => parseWidgetOrigins(raw)).toThrow();
});
