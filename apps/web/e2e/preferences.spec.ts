import { expect, test } from "@playwright/test";
import { expectNoSeriousA11yViolations } from "./helpers";

test.describe("language", () => {
  test("switching to Spanish translates the page, sets lang and survives a reload", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await page.getByRole("radio", { name: "Español" }).check();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tu salón de belleza.");
    await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tu salón de belleza.");
    await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
    await page.goto("/book");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Elige tus servicios");
    await expect(page.getByText(/\$\s?15\.000/).first()).toBeVisible();
    await expectNoSeriousA11yViolations(page, "es-AR booking");
  });

  test("the browser's Spanish preference is the default, and English can be chosen back", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, locale: "es-ES" });
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
    await page.getByRole("radio", { name: "English" }).check();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your beauty salon.");
    await context.close();
  });
});

test.describe("theme", () => {
  test("follows the system preference and the toggle overrides it for good", async ({
    browser,
    baseURL,
  }) => {
    const context = await browser.newContext({ baseURL, colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/");
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect.poll(background).toBe("rgb(23, 18, 20)");
    await expectNoSeriousA11yViolations(page, "home dark");

    await page.getByRole("button", { name: "Switch to light mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(background).toBe("rgb(251, 248, 245)");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect.poll(background).toBe("rgb(251, 248, 245)");
    await expectNoSeriousA11yViolations(page, "home light");
    await context.close();
  });
});

test.describe("offline", () => {
  test("losing the connection shows a banner and a retryable error instead of a blank page", async ({
    page,
    context,
  }) => {
    await page.goto("/book");
    await page.getByRole("checkbox", { name: /Haircut/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: "Any available professional" }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();

    await context.setOffline(true);
    await expect(page.getByText("You are offline. Some actions are unavailable.")).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByText("You are offline. Some actions are unavailable.")).toHaveCount(0);
  });
});

test.describe("timezones", () => {
  test.use({ timezoneId: "Europe/Madrid" });
  test("a visitor in another timezone is told times are salon time", async ({ page }) => {
    await page.goto("/book?services=0198f5a0-7b1c-7000-8000-000000000101&staff=any");
    await expect(page).toHaveURL(/\/book\/time|\/book\/professional|\/book/);
    await page.goto("/book");
    await page.getByRole("checkbox", { name: /Haircut/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("radio", { name: "Any available professional" }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/Your device is set to Europe\/Madrid/)).toBeVisible();
    await expect(page.getByText(/salon time \(America\/Argentina\/Buenos Aires\)/)).toBeVisible();
  });
});
