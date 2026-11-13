export type Theme = "light" | "dark";
export const THEME_COOKIE = "sob_theme";

export function parseThemeCookie(cookieHeader: string | undefined | null): Theme | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === THEME_COOKIE) return value === "dark" || value === "light" ? value : undefined;
  }
  return undefined;
}

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function themeCookieValue(theme: Theme): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

export function nextTheme(effective: Theme): Theme {
  return effective === "dark" ? "light" : "dark";
}

/** The scheme the visitor currently sees: an explicit choice, else the OS preference. */
export function effectiveTheme(explicit: Theme | undefined): Theme {
  if (explicit) return explicit;
  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
  ) {
    return "dark";
  }
  return "light";
}
