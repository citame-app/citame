import { expect, test } from "@playwright/test";
import { reviewedStaffAccessSchema } from "@sob/contracts";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations, PASSWORD } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`staff access profiles — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("owner restricts staff access, then upgrades the existing session to operational manager", async ({
      page,
    }) => {
      const unique = crypto.randomUUID();
      const email = `access-${unique}@example.com`;
      const owner = await asOwner();
      try {
        const created = await owner.post("/api/admin/staff-accounts", {
          data: {
            name: `Access ${unique}`,
            displayName: `Access ${unique}`,
            email,
            password: PASSWORD,
          },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const { staffId } = await created.json();
        const accessPath = `/api/admin/staff/${staffId}/access/reviewed`;
        await signInAs(page, OWNER_EMAIL, `/admin/staff?member=${staffId}`);
        await page
          .getByRole("combobox", { name: "Access profile", exact: true })
          .selectOption("restricted");
        const saved = page.waitForResponse(
          (response) =>
            response.url().endsWith(accessPath) && response.request().method() === "PUT",
        );
        await page.getByRole("button", { name: "Save access profile", exact: true }).click();
        const savedResponse = await saved;
        expect(savedResponse.ok()).toBe(true);
        const restricted = reviewedStaffAccessSchema.parse(await savedResponse.json());
        await page.context().clearCookies();
        await signInAs(page, email, "/admin/calendar");
        await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
        const addToCalendar = page.getByRole("button", { name: "Add to calendar", exact: true });
        await expect(addToCalendar).toHaveCount(0);
        await expect(page.getByRole("link", { name: "Sales & register", exact: true })).toHaveCount(
          0,
        );
        const denied = await page.request.get("/api/admin/commerce/checkouts");
        expect(denied.status()).toBe(403);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `restricted calendar ${scheme}`);
        const promoted = await owner.put(accessPath, {
          data: {
            preset: "manager",
            generation: restricted.generation,
            accountId: restricted.accountId,
            version: restricted.access.version,
          },
        });
        expect(promoted.ok(), await promoted.text()).toBe(true);
        await page.reload();
        await addToCalendar.click();
        await expect(
          page.getByRole("button", { name: "New appointment", exact: true }),
        ).toBeVisible();
        await page.keyboard.press("Escape");
        await page.goto("/admin/commerce");
        await expect(
          page.getByRole("button", { name: "Financial reports & commissions", exact: true }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: "Inventory", exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `manager sales ${scheme}`);
        expect((await page.request.post("/api/admin/staff-accounts", { data: {} })).status()).toBe(
          403,
        );
        const manager = reviewedStaffAccessSchema.parse(await promoted.json());
        expect(
          (
            await page.request.put(accessPath, {
              data: {
                preset: "manager",
                generation: manager.generation,
                accountId: manager.accountId,
                version: manager.access.version,
              },
            })
          ).status(),
        ).toBe(403);
      } finally {
        await owner.dispose();
      }
    });
  });
}
