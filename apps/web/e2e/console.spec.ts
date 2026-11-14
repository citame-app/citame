import { expect, test } from "@playwright/test";
import { pickProfessional, startBooking } from "./helpers";

// A hydration mismatch or a 404 for an asset is a real defect even when the page "looks" fine.
test("key pages load without console errors, failed requests or hydration warnings", async ({
  page,
}) => {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().includes("/api/")) {
      problems.push(`${response.status()} ${response.url()}`);
    }
  });

  for (const path of ["/", "/book", "/sign-in", "/sign-up"]) {
    await page.goto(path);
    await expect(page.locator("main")).toBeVisible();
  }
  await startBooking(page);
  await pickProfessional(page, "Any available professional");
  await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
  // Reload the time step so it is server-rendered with data and then hydrated.
  await page.reload();
  await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("the Spanish time step hydrates without mismatches in the browser's own ICU", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(message.text());
  });
  page.on("pageerror", (error) => problems.push(error.message));
  await page.goto("/book");
  await page.getByRole("checkbox", { name: /Haircut/ }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByRole("radio", { name: /Cualquier profesional disponible/ }).check();
  await page.getByRole("button", { name: "Continuar" }).click();
  await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
  expect(problems).toEqual([]);
  await context.close();
});
