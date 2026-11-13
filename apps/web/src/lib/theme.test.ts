import { describe, expect, test } from "bun:test";
import { nextTheme, parseThemeCookie, THEME_COOKIE, themeCookieValue } from "./theme";

describe("theme cookie", () => {
  test("round-trips an explicit choice", () => {
    expect(parseThemeCookie(`x=1; ${THEME_COOKIE}=dark`)).toBe("dark");
    expect(parseThemeCookie(`${THEME_COOKIE}=light`)).toBe("light");
  });

  test("anything else means follow the system", () => {
    expect(parseThemeCookie(undefined)).toBeUndefined();
    expect(parseThemeCookie(`${THEME_COOKIE}=sepia`)).toBeUndefined();
    expect(parseThemeCookie("a=b")).toBeUndefined();
  });

  test("is long-lived and scoped to the whole site", () => {
    const value = themeCookieValue("dark");
    expect(value).toContain(`${THEME_COOKIE}=dark`);
    expect(value).toContain("Path=/");
    expect(value).toContain("Max-Age=");
    expect(value).toContain("SameSite=Lax");
  });
});

describe("nextTheme", () => {
  test("flips the theme the visitor currently sees", () => {
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("light");
  });
});
