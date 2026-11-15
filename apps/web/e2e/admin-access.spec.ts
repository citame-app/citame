import { expect, test } from "@playwright/test";
import { ensureStaff, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { createClient, expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

const STAFF_EMAIL = "e2e-staff@example.com";

test.beforeAll(async () => {
  await ensureStaff(STAFF_EMAIL, "E2E Stylist");
});

test.describe("role access matrix", () => {
  test("anonymous visitors are sent to sign in and back", async ({ page }) => {
    await page.goto("/admin/calendar");
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Fadmin%2Fcalendar/);
  });

  test("clients cannot enter the dashboard", async ({ page, request, baseURL }) => {
    const client = await createClient(request, baseURL as string);
    await signInThroughUi(page, client.email);
    await expect(page).toHaveURL(/\/account$/);
    await page.goto("/admin/reports");
    await expect(page).toHaveURL(/\/account$/);
  });

  test("staff see their sections and are redirected from owner pages with a clear message", async ({
    page,
  }) => {
    await signInAs(page, STAFF_EMAIL);
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Dashboard sections" });
    const mobileNav = page.getByRole("navigation", { name: "Dashboard sections (mobile)" });
    const visibleNav = (await nav.isVisible()) ? nav : mobileNav;
    if (await nav.isVisible())
      await expect(nav.getByRole("link", { name: "My schedule" })).toBeVisible();
    else {
      await mobileNav.getByRole("button", { name: "More" }).click();
      await expect(
        page.getByRole("dialog", { name: "More" }).getByRole("link", { name: "My schedule" }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
    }
    await expect(visibleNav.getByRole("link", { name: "Services" })).toHaveCount(0);
    await expect(visibleNav.getByRole("link", { name: "Settings" })).toHaveCount(0);
    for (const path of ["/admin/services", "/admin/settings"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/admin\?notice=forbidden$/);
      await expect(
        page.getByRole("alert").filter({ hasText: "You do not have access to that page" }),
      ).toBeVisible();
    }
    for (const path of [
      "/admin/calendar",
      "/admin/clients",
      "/admin/staff",
      "/admin/reports",
      "/admin/commerce",
    ]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`${path}`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
  });

  test("the owner reaches every section", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL);
    for (const [path, heading] of [
      ["/admin", "Today"],
      ["/admin/calendar", "Calendar"],
      ["/admin/clients", "Clients"],
      ["/admin/services", "Services"],
      ["/admin/staff", "Team"],
      ["/admin/reports", "Reports"],
      ["/admin/settings", "Settings"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    }
  });

  test("the staff calendar defaults to their own column only", async ({ page }) => {
    await signInAs(page, STAFF_EMAIL, "/admin/calendar");
    await expect(page.getByRole("group", { name: /Schedule for E2E Stylist/ })).toBeVisible();
    await expect(page.getByRole("group", { name: /Schedule for Stylist A/ })).toHaveCount(0);
    await expectNoSeriousA11yViolations(page, "staff calendar");
  });
});
