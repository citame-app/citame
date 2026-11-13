import { describe, expect, test } from "bun:test";
import type { MeResponse } from "@sob/contracts";
import { homeFor, resolveAccess, safeRedirect } from "./access";

const me = (role: MeResponse["user"]["role"]): MeResponse => ({
  user: { id: "u", email: "a@example.com", name: "A", role },
  staffId: null,
  clientId: null,
  phone: null,
});

describe("resolveAccess", () => {
  test("/account needs any signed-in role", () => {
    expect(resolveAccess("account", null)).toEqual({ type: "signin" });
    for (const role of ["client", "staff", "owner"] as const) {
      expect(resolveAccess("account", me(role))).toEqual({ type: "allow" });
    }
  });

  test("/admin needs staff or owner: clients are forbidden, anonymous visitors sign in", () => {
    expect(resolveAccess("admin", null)).toEqual({ type: "signin" });
    expect(resolveAccess("admin", me("client"))).toEqual({ type: "forbidden" });
    expect(resolveAccess("admin", me("staff"))).toEqual({ type: "allow" });
    expect(resolveAccess("admin", me("owner"))).toEqual({ type: "allow" });
  });

  test("booking needs a session only at the confirm step", () => {
    expect(resolveAccess("public", null)).toEqual({ type: "allow" });
  });

  test("auth pages bounce signed-in people to their home", () => {
    expect(resolveAccess("guest", null)).toEqual({ type: "allow" });
    expect(resolveAccess("guest", me("client"))).toEqual({ type: "redirect-home" });
  });
});

describe("homeFor", () => {
  test("staff and owner land on the dashboard, clients on their account", () => {
    expect(homeFor("client")).toBe("/account");
    expect(homeFor("staff")).toBe("/admin");
    expect(homeFor("owner")).toBe("/admin");
  });
});

describe("safeRedirect", () => {
  test("keeps same-site paths with query strings", () => {
    expect(safeRedirect("/book/review?services=a&staff=any")).toBe(
      "/book/review?services=a&staff=any",
    );
    expect(safeRedirect("/account")).toBe("/account");
  });

  test("rejects anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example",
      "//evil.example",
      "/\\evil.example",
      "javascript:alert(1)",
      "evil",
      "",
      undefined,
      "/%0d%0aSet-Cookie: x=1",
    ]) {
      expect(safeRedirect(bad)).toBe("/");
    }
  });

  test("never bounces back to an auth page", () => {
    expect(safeRedirect("/sign-in?redirect=/account")).toBe("/");
    expect(safeRedirect("/sign-up")).toBe("/");
  });

  test("uses the provided fallback", () => {
    expect(safeRedirect(undefined, "/account")).toBe("/account");
  });
});
