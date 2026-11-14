import { describe, expect, test } from "bun:test";
import { adminGuard, adminNavFor, sectionOfPath } from "./nav";

describe("sectionOfPath", () => {
  test("maps admin paths to their section", () => {
    expect(sectionOfPath("/admin")).toBe("today");
    expect(sectionOfPath("/admin/")).toBe("today");
    expect(sectionOfPath("/admin/calendar")).toBe("calendar");
    expect(sectionOfPath("/admin/clients/0198f5a0")).toBe("clients");
    expect(sectionOfPath("/admin/settings")).toBe("settings");
  });

  test("unknown admin paths fall back to the overview", () => {
    expect(sectionOfPath("/admin/nope")).toBe("today");
  });
});

describe("adminNavFor", () => {
  test("the owner sees every section in order", () => {
    expect(adminNavFor("owner").map((item) => item.section)).toEqual([
      "today",
      "calendar",
      "clients",
      "services",
      "staff",
      "reports",
      "settings",
    ]);
  });

  test("staff do not see services or settings", () => {
    expect(adminNavFor("staff").map((item) => item.section)).toEqual([
      "today",
      "calendar",
      "clients",
      "staff",
      "reports",
    ]);
  });

  test("clients see nothing", () => {
    expect(adminNavFor("client")).toEqual([]);
  });
});

describe("adminGuard", () => {
  test("allows what the role may open", () => {
    expect(adminGuard("/admin/services", "owner")).toEqual({ type: "allow" });
    expect(adminGuard("/admin/reports", "staff")).toEqual({ type: "allow" });
  });

  test("redirects staff away from owner-only sections with a reason", () => {
    expect(adminGuard("/admin/services", "staff")).toEqual({
      type: "redirect",
      to: "/admin",
      notice: "forbidden",
    });
    expect(adminGuard("/admin/settings", "staff").type).toBe("redirect");
  });

  test("clients never enter, not even the overview", () => {
    expect(adminGuard("/admin", "client")).toEqual({
      type: "redirect",
      to: "/account",
      notice: "forbidden",
    });
  });
});
