import { expect, test } from "@playwright/test";
import {
  createClient,
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  startBooking,
} from "./helpers";

test.describe("accessibility (axe: zero serious or critical violations)", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });

      test("public pages", async ({ page }) => {
        for (const path of ["/", "/book", "/sign-in", "/sign-up", "/does-not-exist"]) {
          await page.goto(path);
          await expect(page.locator("main")).toBeVisible();
          await expectNoSeriousA11yViolations(page, `${path} (${scheme})`);
        }
      });

      test("every booking step and the confirmation", async ({ page, request, baseURL }) => {
        await startBooking(page);
        await expectNoSeriousA11yViolations(page, `professional (${scheme})`);
        await pickProfessional(page, "Any available professional");
        await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
        await expectNoSeriousA11yViolations(page, `time (${scheme})`);
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue" }).click();
        await expect(page.getByRole("heading", { name: "Sign in to confirm" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `review anonymous (${scheme})`);

        const reviewUrl = page.url();
        const client = await createClient(request, baseURL as string);
        await page.goto("/sign-in");
        await page.getByLabel("Email").fill(client.email);
        await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await expect(page).toHaveURL(/\/account$/);
        await page.goto(reviewUrl);
        await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `review signed in (${scheme})`);
        await page.getByRole("button", { name: "Confirm booking" }).click();
        await expect(page.getByRole("heading", { name: "You're booked!" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `confirmed (${scheme})`);
        await page.getByRole("link", { name: "Manage appointment" }).click();
        await expect(page.getByRole("article").first()).toBeVisible();
        await expectNoSeriousA11yViolations(page, `account (${scheme})`);
        await page.getByRole("link", { name: "Profile" }).click();
        await expect(page.getByLabel("Full name")).toBeVisible();
        await expectNoSeriousA11yViolations(page, `profile (${scheme})`);
        await page.goto("/account");
        await page.getByRole("button", { name: "Reschedule" }).click();
        await expect(page.getByText("Current time")).toBeVisible();
        await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
        await expectNoSeriousA11yViolations(page, `reschedule (${scheme})`);
        await page.goto("/account");
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
        await expectNoSeriousA11yViolations(page, `cancel dialog (${scheme})`);
      });
    });
  }
});
