import { expect, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
  startBooking,
} from "./helpers";

// Paths explored in the running application before authoring these regressions.
const adminPaths = [
  "/admin",
  "/admin/calendar",
  "/admin/clients",
  "/admin/services",
  "/admin/staff",
  "/admin/commerce",
  "/admin/reports",
  "/admin/waitlist",
  "/admin/reputation",
  "/admin/settings",
];
for (const scheme of ["light", "dark"] as const)
  test.describe(`redesigned UI — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("public navigation, editorial assets and forms work across breakpoints", async ({
      page,
    }, info) => {
      test.setTimeout(150000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      const widths = info.project.name === "mobile" ? [320, 390] : [768, 1024, 1440];
      for (const width of widths) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        for (const path of [
          "/",
          "/portfolio",
          "/reviews",
          "/sign-in",
          "/sign-up",
          "/forgot-password",
        ]) {
          await page.goto(path);
          await expect(page.locator("main h1")).toBeVisible();
          await expectNoHorizontalScroll(page);
          if (path === "/") {
            const discovery = page.getByRole("navigation", { name: "See services" });
            await expect(discovery.getByRole("link", { name: "Portfolio" })).toBeVisible();
            await expect(discovery.getByRole("link", { name: "Reviews" })).toBeVisible();
            await expect(page.locator('[data-moment-mounted="1"]')).toHaveCount(1);
            expect(
              await page
                .locator(".salon-hero img")
                .evaluate((img) => (img as HTMLImageElement).naturalWidth),
            ).toBeGreaterThan(0);
          }
        }
      }
      await page.goto("/");
      await page.keyboard.press("Tab");
      const skip = page.getByRole("link", { name: "Skip to main content" });
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("main")).toBeFocused();
      await page.goto("/sign-in");
      await expectNoSeriousA11yViolations(page, `auth ${scheme}`);
      // Native transparent radios expose their visible focus ring on the associated label.
      await page.keyboard.press("Tab");
      for (const language of ["English", "Español"]) {
        const radio = page.getByRole("radio", { name: language, exact: true });
        await radio.focus();
        const id = await radio.getAttribute("id");
        await expect(page.locator(`label[for="${id}"]`)).toHaveCSS("outline-style", "solid");
        await expect(page.locator(`label[for="${id}"]`)).toHaveCSS("outline-width", "3px");
      }
      expect(errors).toEqual([]);
    });

    test("all owner sections keep one current destination and settings drafts survive fragment navigation", async ({
      page,
    }) => {
      test.setTimeout(180000);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await signInThroughUi(page, fixture.ownerEmail);
      await expect(page).toHaveURL(/\/admin$/);
      for (const path of adminPaths) {
        await page.goto(path);
        await expect(page.locator("main h1")).toBeVisible();
        const sidebar = page.getByRole("navigation", { name: "Dashboard sections", exact: true });
        const navigation = (await sidebar.isVisible())
          ? sidebar
          : page.getByRole("navigation", { name: "Dashboard sections (mobile)", exact: true });
        await expect(navigation.locator('[aria-current="page"]')).toHaveCount(1);
        await expectNoHorizontalScroll(page);
        if (path === "/admin/commerce") {
          // CSS decorations must never become part of a destination's accessible name.
          for (const name of [
            "Inventory",
            "Financial reports & commissions",
            "Gift cards & rewards",
          ]) {
            await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
          }
        }
        await expectNoSeriousA11yViolations(page, `${path} ${scheme}`);
      }
      const name = page.getByLabel("Salon name", { exact: true });
      const original = await name.inputValue();
      await name.fill("Unsaved design review");
      const index = page.getByRole("navigation", { name: "Settings", exact: true });
      await index.getByRole("link", { name: "Forms and consent" }).click();
      await expect(page).toHaveURL(/#intake-settings$/);
      await expect(name).toHaveValue("Unsaved design review");
      await name.fill(original);
      expect(errors).toEqual([]);
    });

    test("booking, confirmation and customer account retain the complete workflow", async ({
      page,
    }) => {
      test.setTimeout(180000);
      await signInThroughUi(page, fixture.clientEmail);
      await expect(page).toHaveURL(/\/account$/);
      await startBooking(page);
      await expectNoHorizontalScroll(page);
      await pickProfessional(page, "Any available professional");
      await pickFirstTime(page);
      await expectNoSeriousA11yViolations(page, `time ${scheme}`);
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Confirm booking", exact: true }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: "You're booked!", exact: true }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Manage appointment", exact: true }).click();
      await expect(page.getByRole("article").first()).toBeVisible();
      for (const path of [
        "/account",
        "/account/profile",
        "/account/notifications",
        "/account/reviews",
        "/account/rewards",
        "/account/waitlist",
      ]) {
        await page.goto(path);
        await expect(page.locator("main h1")).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `${path} ${scheme}`);
      }
    });
  });
