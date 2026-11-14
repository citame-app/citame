import { describe, expect, test } from "bun:test";
import { type AuthEmailKind, localeFromRequest, renderAuthEmail } from "./auth-emails";

const URL_ = "https://salon.example/api/auth/verify-email?token=abc&callbackURL=%2Faccount";
const KINDS: AuthEmailKind[] = ["verify_email", "reset_password", "staff_invite", "account_exists"];

describe("renderAuthEmail", () => {
  for (const locale of ["en", "es-AR"] as const) {
    for (const kind of KINDS) {
      test(`${kind} (${locale}) carries the link in text and html, and never in the subject`, () => {
        const mail = renderAuthEmail({
          kind,
          locale,
          salonName: "Sisters of Beauty",
          url: URL_,
          expiresInMinutes: 60,
        });
        expect(mail.subject.length).toBeGreaterThan(5);
        expect(mail.subject).not.toContain("token=");
        expect(mail.text).toContain(URL_);
        expect(mail.html).toContain(URL_.replaceAll("&", "&amp;"));
        expect(mail.html).toContain(`<html lang="${locale}">`);
        expect(mail.text).toContain("Sisters of Beauty");
      });
    }
  }

  test("the expiry is stated in the person's language", () => {
    const base = { kind: "reset_password", salonName: "S", url: URL_ } as const;
    expect(renderAuthEmail({ ...base, locale: "en", expiresInMinutes: 60 }).text).toContain(
      "1 hour",
    );
    expect(renderAuthEmail({ ...base, locale: "es-AR", expiresInMinutes: 60 }).text).toContain(
      "1 hora",
    );
    expect(renderAuthEmail({ ...base, locale: "en", expiresInMinutes: 4320 }).text).toContain(
      "3 days",
    );
  });

  test("untrusted values are html-escaped", () => {
    const mail = renderAuthEmail({
      kind: "verify_email",
      locale: "en",
      salonName: `<script>alert(1)</script>`,
      url: URL_,
      expiresInMinutes: 60,
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
  });

  test("the account_exists notice never reveals more than the address owner already knows", () => {
    const mail = renderAuthEmail({
      kind: "account_exists",
      locale: "en",
      salonName: "S",
      url: "https://salon.example/reset-password",
      expiresInMinutes: 60,
    });
    expect(mail.text.toLowerCase()).toContain("already");
    expect(mail.text.toLowerCase()).toContain("ignore");
  });
});

describe("localeFromRequest", () => {
  const req = (headers: Record<string, string>) => new Request("http://x/", { headers });

  test("the visitor's language cookie wins, then Accept-Language, then the default", () => {
    expect(localeFromRequest(req({ cookie: "a=b; sob_locale=es-AR" }), "en")).toBe("es-AR");
    expect(localeFromRequest(req({ "accept-language": "es-ES,es;q=0.9,en;q=0.8" }), "en")).toBe(
      "es-AR",
    );
    expect(localeFromRequest(req({ "accept-language": "fr-FR" }), "en")).toBe("en");
    expect(localeFromRequest(undefined, "es-AR")).toBe("es-AR");
    expect(localeFromRequest(req({ cookie: "sob_locale=klingon" }), "en")).toBe("en");
  });
});
