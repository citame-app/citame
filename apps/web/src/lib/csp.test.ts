import { describe, expect, test } from "bun:test";
import { buildCsp, createNonce } from "./csp";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `) || part === name);

describe("buildCsp", () => {
  const csp = buildCsp({ nonce: "abc123", https: true });

  test("scripts run only from this origin or with the per-request nonce, never inline-by-default", () => {
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-abc123'");
    expect(csp).not.toContain("unsafe-eval");
    expect(directive(csp, "script-src")).not.toContain("unsafe-inline");
  });

  test("framing, base URI, plugins and form targets are locked down", () => {
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "form-action")).toBe(
      "form-action 'self' https://sis.redsys.es https://sis-t.redsys.es:25443",
    );
  });

  test("everything else is same-origin; data: only for images", () => {
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data:");
  });

  test("style attributes are allowed (React inline styles, chart libraries), style elements need the nonce", () => {
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'nonce-abc123'");
    expect(directive(csp, "style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  test("upgrade-insecure-requests only on https deployments", () => {
    expect(csp).toContain("upgrade-insecure-requests");
    expect(buildCsp({ nonce: "n", https: false })).not.toContain("upgrade-insecure-requests");
  });
});

describe("createNonce", () => {
  test("is unpredictable, url-safe and unique per call", () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });
});

test("hosted Redsys checkout permits only the explicit bank origins alongside the salon", () => {
  const csp = buildCsp({ nonce: "test-nonce", https: true });
  expect(directive(csp, "form-action")).toBe(
    "form-action 'self' https://sis.redsys.es https://sis-t.redsys.es:25443",
  );
  expect(csp).not.toContain("https:;");
});
