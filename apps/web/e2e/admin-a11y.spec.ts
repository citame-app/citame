import { expect, test } from "@playwright/test";
import { book, ensureStaff, freeHour, OWNER_EMAIL, runDays, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

const stamp = Date.now().toString(36);
const ROUTES = [
  ["/admin", "Today"],
  ["/admin/calendar", "Calendar"],
  ["/admin/clients", "Clients"],
  ["/admin/services", "Services"],
  ["/admin/staff", "Team"],
  ["/admin/reports", "Reports"],
  ["/admin/settings", "Settings"],
] as const;

test.describe("admin accessibility (axe: zero serious or critical violations)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });

      test("every admin route", async ({ page }) => {
        test.setTimeout(120_000);
        await signInAs(page, OWNER_EMAIL, "/admin");
        for (const [path, heading] of ROUTES) {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
          await page.waitForLoadState("networkidle");
          await expectNoSeriousA11yViolations(page, `${path} (${scheme})`);
        }
        const { staffId } = await ensureStaff("e2e-staff@example.com", "E2E Stylist");
        for (const tab of ["hours", "timeoff"]) {
          await page.goto(`/admin/staff?member=${staffId}&tab=${tab}`);
          await expect(
            page.getByRole("tab", { name: tab === "hours" ? "Working hours" : "Time off" }),
          ).toBeVisible();
          await page.waitForLoadState("networkidle");
          await expectNoSeriousA11yViolations(page, `staff ${tab} (${scheme})`);
        }
        await page.goto("/admin/staff");
      });

      test("calendar with data, the drawer and the forms", async ({ page }) => {
        test.setTimeout(120_000);
        await ensureStaff("e2e-staff@example.com", "E2E Stylist");
        const [date] = runDays(1, -1);
        const { asOwner } = await import("./admin-helpers");
        const owner = await asOwner();
        const h = await freeHour(date as string);
        await book(owner, {
          date: date as string,
          time: `${String(h).padStart(2, "0")}:00`,
          client: `Axe ${stamp}`,
        });
        await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
        await expect(page.getByRole("button", { name: new RegExp(`Axe ${stamp}`) })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `calendar (${scheme})`);
        await page.getByRole("button", { name: new RegExp(`Axe ${stamp}`) }).click();
        await expect(page.getByRole("dialog", { name: `Axe ${stamp}` })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoSeriousA11yViolations(page, `drawer (${scheme})`);
        await page.keyboard.press("Escape");
        await page.getByRole("button", { name: "New appointment" }).click();
        await expect(page.getByRole("dialog", { name: "New appointment" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `new appointment (${scheme})`);
        await page.keyboard.press("Escape");
        await page.keyboard.press("?");
        await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `shortcuts (${scheme})`);
      });

      test("services form, week view and client detail", async ({ page }) => {
        test.setTimeout(120_000);
        await signInAs(page, OWNER_EMAIL, "/admin/services");
        await page.getByRole("button", { name: "New service" }).first().click();
        await expect(page.getByRole("dialog", { name: "New service" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `service form (${scheme})`);
        await page.keyboard.press("Escape");
        await page.goto("/admin/calendar?view=week");
        await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
        await page.waitForLoadState("networkidle");
        await expectNoSeriousA11yViolations(page, `week view (${scheme})`);
      });
    });
  }
});
