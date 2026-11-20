import { describe, expect, test } from "bun:test";
import { adminGuard, adminNavFor, sectionOfPath } from "./nav";

describe("sectionOfPath", () => {
  test("maps admin paths to their section", () => {
    expect(sectionOfPath("/admin")).toBe("calendar");
    expect(sectionOfPath("/admin/")).toBe("calendar");
    expect(sectionOfPath("/admin/calendar")).toBe("calendar");
    expect(sectionOfPath("/admin/clients/0198f5a0")).toBe("clients");
    expect(sectionOfPath("/admin/settings")).toBe("settings");
  });

  test("unknown admin paths use the calendar as the shell fallback", () => {
    expect(sectionOfPath("/admin/nope")).toBe("calendar");
  });
});

describe("adminNavFor", () => {
  test("the owner sees every section in order", () => {
    expect(adminNavFor("owner").map((item) => item.section)).toEqual([
      "calendar",
      "waitlist",
      "commerce",
      "clients",
      "services",
      "staff",
      "reports",
      "marketing",
      "reputation",
      "settings",
    ]);
  });

  test("staff do not see services or settings", () => {
    expect(adminNavFor("staff").map((item) => item.section)).toEqual([
      "calendar",
      "waitlist",
      "commerce",
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
      to: "/admin/calendar",
      notice: "forbidden",
    });
    expect(adminGuard("/admin/settings", "staff").type).toBe("redirect");
  });

  test("clients never enter, including the legacy entry point", () => {
    expect(adminGuard("/admin", "client")).toEqual({
      type: "redirect",
      to: "/account",
      notice: "forbidden",
    });
  });
});

test("operators can reach the sales register, clients cannot", () => {
  expect(sectionOfPath("/admin/commerce")).toBe("commerce");
  expect(adminGuard("/admin/commerce", "staff")).toEqual({ type: "allow" });
  expect(adminGuard("/admin/commerce", "client").type).toBe("redirect");
});
test("access presets expose permitted sections without granting owner account or settings control", () => {
  expect(adminNavFor("staff", "manager").map((item) => item.section)).toContain("services");
  expect(adminNavFor("staff", "manager").map((item) => item.section)).not.toContain("settings");
  expect(adminNavFor("staff", "restricted").map((item) => item.section)).toEqual([
    "calendar",
    "staff",
  ]);
  expect(adminGuard("/admin/commerce", "staff", "restricted").type).toBe("redirect");
});

test("the waitlist is available to booking operators and hidden from restricted staff", () => {
  expect(sectionOfPath("/admin/waitlist")).toBe("waitlist");
  expect(adminNavFor("staff", "receptionist").map((item) => item.section)).toContain("waitlist");
  expect(adminNavFor("staff", "restricted").map((item) => item.section)).not.toContain("waitlist");
  expect(adminGuard("/admin/waitlist", "staff", "restricted").type).toBe("redirect");
});

test("reputation moderation is available only to owners and managers", () => {
  expect(adminGuard("/admin/reputation", "staff", "receptionist").type).toBe("redirect");
  expect(adminGuard("/admin/reputation", "staff", "manager").type).toBe("allow");
});
