import { describe, expect, test } from "bun:test";
import {
  createTranslator,
  LOCALE_COOKIE,
  localeCookieValue,
  parseLocaleCookie,
  resolveLocale,
} from "./index";
import { en } from "./messages/en";
import { esAR } from "./messages/es-AR";

const placeholders = (message: string) =>
  [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("catalog completeness", () => {
  test("es-AR defines exactly the keys of en", () => {
    expect(Object.keys(esAR).sort()).toEqual(Object.keys(en).sort());
  });

  test("every message keeps the same placeholders in both languages", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect({ key, placeholders: placeholders(esAR[key]) }).toEqual({
        key,
        placeholders: placeholders(en[key]),
      });
    }
  });

  test("no message is empty and es-AR is actually translated", () => {
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(esAR[key].trim().length).toBeGreaterThan(0);
    }
    const identical = Object.keys(en).filter(
      (key) => en[key as keyof typeof en] === esAR[key as keyof typeof en],
    );
    // Brand names and the like may match; a mostly-untranslated catalog must not.
    expect(identical.length).toBeLessThan(Object.keys(en).length * 0.1);
  });
});

describe("translator", () => {
  test("interpolates named values", () => {
    const t = createTranslator("en");
    expect(t("common.greeting", { name: "Lucia" })).toBe("Hello, Lucia");
    expect(createTranslator("es-AR")("common.greeting", { name: "Lucia" })).toBe("Hola, Lucia");
  });

  test("selects the plural form for the locale", () => {
    const t = createTranslator("en");
    expect(t("booking.summary.services", { count: 1 })).toBe("1 service");
    expect(t("booking.summary.services", { count: 3 })).toBe("3 services");
    expect(createTranslator("es-AR")("booking.summary.services", { count: 2 })).toBe("2 servicios");
  });

  test("a missing interpolation value is left visible instead of crashing", () => {
    expect(createTranslator("en")("common.greeting")).toBe("Hello, {name}");
  });
});

describe("locale resolution", () => {
  test("defaults to en", () => {
    expect(resolveLocale({})).toBe("en");
  });

  test("the cookie wins over Accept-Language", () => {
    expect(resolveLocale({ cookie: `${LOCALE_COOKIE}=es-AR`, acceptLanguage: "en-US" })).toBe(
      "es-AR",
    );
    expect(resolveLocale({ cookie: `a=b; ${LOCALE_COOKIE}=en`, acceptLanguage: "es-AR" })).toBe(
      "en",
    );
  });

  test("any Spanish Accept-Language maps to es-AR, anything else to en", () => {
    expect(resolveLocale({ acceptLanguage: "es-ES,es;q=0.9,en;q=0.8" })).toBe("es-AR");
    expect(resolveLocale({ acceptLanguage: "fr-FR,fr;q=0.9" })).toBe("en");
  });

  test("ignores an unsupported cookie value", () => {
    expect(parseLocaleCookie(`${LOCALE_COOKIE}=klingon`)).toBeUndefined();
  });

  test("builds a long-lived cookie scoped to the site", () => {
    const value = localeCookieValue("es-AR");
    expect(value).toContain(`${LOCALE_COOKIE}=es-AR`);
    expect(value).toContain("Path=/");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Max-Age=");
  });
});
