import { en, type MessageKey } from "./messages/en";
import { esAR } from "./messages/es-AR";

export const LOCALES = ["en", "es-AR"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "sob_locale";

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, "es-AR": esAR };

type PluralSuffix = "_zero" | "_one" | "_two" | "_few" | "_many" | "_other";
/** Keys as callers write them: plural variants collapse into their base key. */
export type TranslationKey = MessageKey extends infer K
  ? K extends `${infer Base}${PluralSuffix}`
    ? Base
    : K
  : never;

export type TranslationValues = Record<string, string | number>;
export type Translator = (key: TranslationKey, values?: TranslationValues) => string;

export function isLocale(value: string | undefined): value is Locale {
  return (LOCALES as readonly string[]).includes(value ?? "");
}

export function createTranslator(locale: Locale): Translator {
  const catalog = catalogs[locale];
  const plurals = new Intl.PluralRules(locale);
  const lookup = catalog as Record<string, string | undefined>;
  const fallback = en as Record<string, string | undefined>;

  return (key, values = {}) => {
    let message = lookup[key] ?? fallback[key];
    if (message === undefined && typeof values.count === "number") {
      const category = plurals.select(values.count);
      message =
        lookup[`${key}_${category}`] ??
        lookup[`${key}_other`] ??
        fallback[`${key}_${category}`] ??
        fallback[`${key}_other`];
    }
    if (message === undefined) return key;
    return message.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      name in values ? String(values[name]) : placeholder,
    );
  };
}

export function parseLocaleCookie(cookieHeader: string | undefined | null): Locale | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === LOCALE_COOKIE) {
      const value = decodeURIComponent(rest.join("="));
      return isLocale(value) ? value : undefined;
    }
  }
  return undefined;
}

export function resolveLocale({
  cookie,
  acceptLanguage,
}: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): Locale {
  const fromCookie = parseLocaleCookie(cookie);
  if (fromCookie) return fromCookie;
  const preferred = acceptLanguage?.split(",")[0]?.trim().toLowerCase() ?? "";
  if (preferred.startsWith("es")) return "es-AR";
  return DEFAULT_LOCALE;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function localeCookieValue(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
