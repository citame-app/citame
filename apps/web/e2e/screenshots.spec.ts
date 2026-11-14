import { expect, type Page, test } from "@playwright/test";
import {
  createClient,
  pickFirstTime,
  pickProfessional,
  signedInContext,
  startBooking,
} from "./helpers";

/** Not assertions: a visual record of every screen, reviewed by a human. Output is git-ignored. */
test.describe("screenshots", () => {
  let index = 0;
  const shoot = async (page: Page, project: string, name: string) => {
    index += 1;
    await page.waitForTimeout(250);
    await page.screenshot({
      path: `e2e/screenshots/${project}/${String(index).padStart(2, "0")}-${name}.png`,
      fullPage: true,
      animations: "disabled",
    });
  };

  test("capture", async ({ page, request, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const project = testInfo.project.name;
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shoot(page, project, "home");

    await startBooking(page);
    await shoot(page, project, "booking-professional");
    await page.goto("/book");
    await page.getByRole("checkbox", { name: /Haircut/ }).check();
    await page.getByRole("checkbox", { name: /Blow dry/ }).check();
    await shoot(page, project, "booking-services-selected");
    await page.getByRole("button", { name: "Continue" }).click();
    await pickProfessional(page, "Any available professional");
    await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
    await shoot(page, project, "booking-time");
    await pickFirstTime(page);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("heading", { name: "Sign in to confirm" })).toBeVisible();
    await shoot(page, project, "booking-review-anonymous");

    const client = await createClient(request, baseURL as string);
    const reviewUrl = page.url();
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(client.email);
    await page.getByLabel("Password", { exact: true }).fill("correct horse battery staple");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await shoot(page, project, "account-empty");
    await page.goto(reviewUrl);
    await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();
    await shoot(page, project, "booking-review-signed-in");
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("heading", { name: "You're booked!" })).toBeVisible();
    await shoot(page, project, "booking-confirmed");
    await page.getByRole("link", { name: "Manage appointment" }).click();
    await expect(page.getByText("Just booked")).toBeVisible();
    await shoot(page, project, "account-appointments");
    await page.getByRole("button", { name: "Reschedule" }).click();
    await expect(page.getByText("Current time")).toBeVisible();
    await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
    await shoot(page, project, "account-reschedule");
    await page.goto("/account");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await shoot(page, project, "account-cancel-dialog");
    await page.getByRole("button", { name: "Keep appointment" }).click();
    await page.getByRole("link", { name: "Profile" }).click();
    await expect(page.getByLabel("Full name")).toBeVisible();
    await shoot(page, project, "account-profile");

    await page.getByRole("button", { name: "Sign out" }).click();
    // signing out sends the visitor home: wait for that before navigating on
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
    await shoot(page, project, "sign-up-errors");
    await page.goto("/does-not-exist");
    await shoot(page, project, "not-found");

    await page.route("**/api/availability*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: '{"error":{"code":"internal_error","message":"x"}}',
      }),
    );
    await startBooking(page);
    await pickProfessional(page, "Any available professional");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await shoot(page, project, "booking-time-error");
    await page.unroute("**/api/availability*");

    await page.goto("/");
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await shoot(page, project, "home-dark");
    await page.goto("/book");
    await page.getByRole("checkbox", { name: /Haircut/ }).check();
    await shoot(page, project, "booking-services-dark");
    await page.getByRole("radio", { name: "Español" }).check();
    await shoot(page, project, "booking-services-dark-es");
  });
});
