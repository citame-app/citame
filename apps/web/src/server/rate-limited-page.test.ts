import { describe, expect, test } from "bun:test";
import { renderRateLimitedPage } from "./rate-limited-page";

describe("renderRateLimitedPage", () => {
  test("English copy with the wait time", () => {
    const html = renderRateLimitedPage({ locale: "en", retryAfterSeconds: 17, nonce: "n0nce" });
    expect(html).toContain('<html lang="en"');
    expect(html).toContain("Too many attempts");
    expect(html).toContain("Please wait 17 seconds and try again.");
    expect(html).toContain('<style nonce="n0nce">');
  });

  test("es-AR copy, singular form", () => {
    const html = renderRateLimitedPage({ locale: "es-AR", retryAfterSeconds: 1, nonce: "n0nce" });
    expect(html).toContain('<html lang="es-AR"');
    expect(html).toContain("Demasiados intentos");
    expect(html).toContain("Espera 1 segundo e intenta nuevamente.");
  });

  test("honours an explicit theme and offers a retry link", () => {
    const html = renderRateLimitedPage({
      locale: "en",
      theme: "dark",
      retryAfterSeconds: 5,
      nonce: "n0nce",
    });
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('href=""');
    expect(html).toContain("Try again");
  });

  test("is a complete, script-free document", () => {
    const html = renderRateLimitedPage({ locale: "en", retryAfterSeconds: 5, nonce: "n0nce" });
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).not.toContain("<script");
    expect(html).toContain('<meta name="viewport"');
  });
});
