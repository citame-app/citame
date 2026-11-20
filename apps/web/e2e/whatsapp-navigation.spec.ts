import { expect, test } from "@playwright/test";

test("WhatsApp popup permissions end when the owner leaves the settings document", async ({
  baseURL,
  page,
}) => {
  const email = process.env.E2E_OWNER_EMAIL;
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!email || !password) {
    test.skip(true, "E2E owner credentials are required");
    return;
  }

  if (!baseURL) throw new Error("The WhatsApp navigation test requires a base URL");
  const signedIn = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin: new URL(baseURL).origin },
    data: { email, password },
  });
  expect(signedIn.ok()).toBe(true);
  await page.goto("/admin/settings");
  await expect(page).toHaveURL(/\/admin\/settings$/);

  const whatsapp = page.getByRole("link", { name: "WhatsApp Business" });
  const [settingsDocument] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().isNavigationRequest() &&
        new URL(response.url()).pathname === "/admin/whatsapp",
    ),
    whatsapp.click(),
  ]);
  expect(settingsDocument.headers()["cross-origin-opener-policy"]).toBe("same-origin-allow-popups");
  expect(settingsDocument.headers()["content-security-policy"]).toContain(
    "https://connect.facebook.net",
  );
  await expect(page.getByRole("heading", { name: "WhatsApp Business" })).toBeVisible();
  // Wait for AdminShell's client effect so an unhydrated anchor cannot make this pass.
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--bottom-nav")),
    )
    .toBe("3.5rem");
  const signupTimeOrigin = await page.evaluate(() => performance.timeOrigin);

  const documents: Record<string, string>[] = [];
  page.on("response", (response) => {
    if (
      response.request().isNavigationRequest() &&
      new URL(response.url()).pathname === "/admin/calendar"
    ) {
      documents.push(response.headers());
    }
  });
  await page.getByRole("link", { name: "Calendar", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/calendar(?:\?|$)/);
  await expect
    .poll(() => page.evaluate(() => performance.timeOrigin), { timeout: 5000 })
    .not.toBe(signupTimeOrigin);
  const calendarHeaders = documents.at(-1);
  expect(calendarHeaders?.["cross-origin-opener-policy"]).toBe("same-origin");
  expect(calendarHeaders?.["content-security-policy"]).toContain("script-src");
  expect(calendarHeaders?.["content-security-policy"]).not.toMatch(/facebook\.(com|net)/);

  await page.goBack();
  await expect(page.getByRole("heading", { name: "WhatsApp Business" })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/\/admin\/calendar(?:\?|$)/);
  const calendarTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole("link", { name: "Clients", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Clients", exact: true })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(calendarTimeOrigin);
});
