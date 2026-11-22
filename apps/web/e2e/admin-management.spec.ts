import { expect, test } from "@playwright/test";
import { desktopSalonSettingsSchema } from "@sob/contracts";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

test("the owner can draft, publish, revise and withdraw the public business profile", async ({
  page,
  browser,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, "/admin/settings?section=profile");
  await expect(page).toHaveURL(/\/admin\/settings\?section=profile$/);
  const settingsPath = "/api/admin/settings";
  const response = await page.request.get(`${settingsPath}/desktop`);
  expect(response.status(), await response.text()).toBe(200);
  const original = desktopSalonSettingsSchema.parse(await response.json()).businessProfile;
  if (!original) throw new Error("Missing business profile fixture");
  const visitor = await browser.newPage({ viewport: page.viewportSize() });
  const headers = { Origin: fixture.baseURL };
  const form = page.getByRole("form", { name: "Public business profile" });
  const description = form.getByLabel("Short description");
  const publish = form.getByRole("checkbox", { name: "Publish on the booking site" });
  const save = form.getByRole("button", { name: "Save settings" });
  const label = `Studio overview ${crypto.randomUUID()}`;
  const publicPage = () => visitor.goto(fixture.baseURL);
  try {
    await description.fill(label);
    await form.getByLabel("Public address").fill("9 Synthetic Street");
    await form.getByLabel("Website (HTTPS)").fill("https://example.test/studio");
    await form.getByRole("checkbox", { name: "Wi-Fi", exact: true }).check();
    await expectNoHorizontalScroll(page);
    await save.click();
    await expect(form.getByRole("status", { name: "" })).toHaveText("Settings saved");
    await publicPage();
    await expect(visitor.getByText(label)).toHaveCount(0);

    await publish.check();
    await save.click();
    await expect(form.getByRole("status", { name: "" })).toHaveText("Settings saved");
    await publicPage();
    const profile = visitor.getByRole("region", { name: "About the centre" });
    await expect(profile.getByText(label)).toBeVisible();
    await expect(profile.getByText("9 Synthetic Street")).toBeVisible();
    await expect(profile.getByRole("link", { name: "Website" })).toHaveAttribute(
      "href",
      "https://example.test/studio",
    );
    await expectNoHorizontalScroll(visitor);

    await description.fill(`${label} updated`);
    const remote = await page.request.patch(settingsPath, {
      headers,
      data: { businessProfile: { phone: "+34 555 010 123" } },
    });
    expect(remote.status(), await remote.text()).toBe(200);
    if (await save.isEnabled()) await save.click();
    await form.getByRole("button", { name: "Load latest and review draft" }).click();
    await expect(description).toHaveValue(`${label} updated`);
    await expect(form.getByLabel("Public phone")).toHaveValue("+34 555 010 123");
    await publish.uncheck();
    await save.click();
    await expect(form.getByRole("status", { name: "" })).toHaveText("Settings saved");
    await publicPage();
    await expect(profile).toHaveCount(0);
  } finally {
    const restored = await page.request.patch(settingsPath, {
      headers,
      data: { businessProfile: original },
    });
    expect(restored.status()).toBe(200);
    await visitor.close();
  }
});

test("settings search finds fields and linked pages without discarding drafts", async ({
  page,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, "/admin/settings");
  const name = page.getByLabel("Salon name", { exact: true });
  await name.fill("Unsaved test name");
  const search = page.getByRole("searchbox", { name: "Search settings", exact: true });
  const directory = page.getByRole("navigation", { name: "Settings", exact: true });
  await search.fill("MÍNIMUM NOTICE");
  await expect(directory.getByRole("link")).toHaveCount(1);
  await directory.getByRole("link", { name: "Online booking", exact: true }).click();
  await expect(page).toHaveURL(/section=booking/);
  await expect(page.getByLabel("Minimum notice (minutes)", { exact: true })).toBeVisible();

  await search.fill("nonexistent option");
  await expect(page.getByText("No settings match your search.")).toBeVisible();
  await expect(page.getByLabel("Minimum notice (minutes)", { exact: true })).toBeVisible();

  for (const provider of ["SMTP", "Google Workspace", "Resend"]) {
    await search.fill(provider);
    await expect(directory.getByRole("link")).toHaveCount(1);
    await expect(
      directory.getByRole("link", { name: "Email delivery", exact: true }),
    ).toBeVisible();
  }
  await search.fill("FIRST REMINDER");
  await expect(directory.getByRole("link")).toHaveCount(1);
  await directory.getByRole("link").click();
  await expect(page.getByLabel("First reminder (minutes before)", { exact: true })).toBeVisible();

  await search.fill("no-show fee");
  await expect(directory.getByRole("link")).toHaveCount(1);
  await directory.getByRole("link").click();
  await expect(page.getByLabel("No-show fee (% of service price)", { exact: true })).toBeVisible();

  await search.fill("timezone");
  await directory.getByRole("link", { name: "Business settings", exact: true }).click();
  await expect(name).toHaveValue("Unsaved test name");

  await search.fill("inventory");
  await expect(directory.getByRole("link", { name: "Inventory", exact: true })).toHaveAttribute(
    "href",
    "/admin/commerce?view=inventory",
  );
  await expectNoHorizontalScroll(page);
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`center management — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("standalone clients, groups, catalog metadata, stock ledger and preserved settings drafts", async ({
      page,
    }, info) => {
      test.setTimeout(90000);
      const unique = crypto.randomUUID();
      await signInThroughUi(page, fixture.ownerEmail, "/admin/clients");
      await page.getByRole("button", { name: "New customer", exact: true }).click();
      const form = page.getByRole("dialog", { name: "New customer", exact: true });
      await form.getByLabel("First name", { exact: true }).fill(`Contact ${unique}`);
      await form.getByLabel("Phone", { exact: true }).fill("+34 600 123 123");
      await form.getByLabel("Email", { exact: true }).fill(`contact-${unique}@example.com`);
      await form.getByLabel("Client tags", { exact: true }).fill(`group-${unique.slice(0, 8)}`);
      await form.getByRole("button", { name: "Create", exact: true }).click();
      await expect(
        page.getByRole("heading", { name: `Contact ${unique}`, exact: true }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(`Contact ${unique}`);
      await expect(page.getByLabel("Client tags", { exact: true })).toHaveValue(
        `group-${unique.slice(0, 8)}`,
      );
      await page.getByLabel("Tax identification number", { exact: true }).fill("TEST-123");
      await page.getByLabel("Customer discount (%)", { exact: true }).fill("12.50");
      await page.getByLabel("Month", { exact: true }).selectOption("11");
      await page.getByLabel("Day", { exact: true }).fill("17");
      await page.getByRole("button", { name: "Save changes", exact: true }).first().click();
      await page.reload();
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      await expect(page.getByLabel("Tax identification number", { exact: true })).toHaveValue(
        "TEST-123",
      );
      await expect(page.getByLabel("Customer discount (%)", { exact: true })).toHaveValue("12.5");
      await expect(page.getByLabel("Month", { exact: true })).toHaveValue("11");
      await page.getByRole("button", { name: "Marketing consent", exact: true }).click();
      const permission = page.getByRole("checkbox", {
        name: "The client has authorized email offers",
        exact: true,
      });
      await expect(permission).not.toBeChecked();
      await permission.check();
      await page
        .getByLabel("Source of this permission or withdrawal", { exact: true })
        .fill("Synthetic browser test: explicit permission");
      await page.getByRole("button", { name: "Save changes", exact: true }).first().click();
      await expect(page.getByText("Marketing preference saved", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      const email = page.getByLabel("Contact email", { exact: true });
      await email.fill(`corrected-${unique}@example.com`);
      const contactForm = page.getByRole("form", { name: "Contact", exact: true });
      const emailSaved = page.waitForResponse(
        (response) =>
          response.request().method() === "PATCH" && response.url().includes("/api/admin/clients/"),
      );
      await contactForm.getByRole("button", { name: "Save changes", exact: true }).click();
      expect((await emailSaved).ok()).toBe(true);
      await expect(
        contactForm.getByRole("button", { name: "Save changes", exact: true }),
      ).toBeDisabled();
      await page.reload();
      await page.getByRole("button", { name: "Profile", exact: true }).click();
      await expect(email).toHaveValue(`corrected-${unique}@example.com`);
      await page.getByRole("button", { name: "Marketing consent", exact: true }).click();
      await expect(permission).not.toBeChecked();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `Client ${scheme}`);
      await page.goto("/admin/clients");
      await page.getByRole("button", { name: "Client groups", exact: true }).click();
      await page
        .getByRole("button")
        .filter({ has: page.getByText(`group-${unique.slice(0, 8)}`, { exact: true }) })
        .click();
      await expect(
        page.getByRole("button", { name: `Contact ${unique}`, exact: true }),
      ).toBeVisible();
      await page.goto(`/admin/services?service=${fixture.haircut}`);
      const service = page.getByRole("dialog", { name: "Edit service", exact: true });
      await service.getByLabel("Category", { exact: true }).fill(`Category-${unique}`);
      await service.getByRole("button", { name: "#2C7B79", exact: true }).click();
      await service.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(service).not.toBeVisible();
      await page.reload();
      await expect(service.getByLabel("Category", { exact: true })).toHaveValue(
        `Category-${unique}`,
      );
      await expect(service.getByRole("button", { name: "#2C7B79", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await service.getByRole("button", { name: "Close panel", exact: true }).click();
      await page.goto("/admin/commerce?view=inventory");
      await page.getByRole("button", { name: "New product", exact: true }).click();
      await page.getByLabel("Product name", { exact: true }).fill(`Product ${unique}`);
      await page.getByLabel("Category", { exact: true }).fill(`Care-${unique}`);
      await page.getByLabel("Brand", { exact: true }).fill("Studio");
      await page.getByLabel("Included tax (%)", { exact: true }).fill("21");
      await page.getByLabel("Net retail price", { exact: true }).fill("10.00");
      await expect(page.getByLabel("Sale price (EUR)", { exact: true })).toHaveValue("12.10");
      await page.getByLabel("Opening stock", { exact: true }).fill("3");
      await page.getByLabel("Target stock", { exact: true }).fill("10");
      await page.getByRole("button", { name: "Save product", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Stock history", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
      await page.getByRole("button", { name: "Stock movements", exact: true }).click();
      await page.getByLabel("Search movements", { exact: true }).fill(unique);
      await expect(
        page.getByRole("heading", { name: `Product ${unique}`, exact: true }),
      ).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `Stock ledger ${scheme}`);
      await page.goto("/admin/marketing");
      await page
        .getByRole("button", { name: "Campaigns and automations", exact: true })
        .first()
        .click();
      await page.getByRole("button", { name: "New campaign", exact: true }).click();
      const campaign = page.getByRole("dialog", { name: "New campaign", exact: true });
      await campaign.getByRole("button", { name: "Birthday greeting", exact: true }).click();
      await campaign.getByLabel("Campaign name", { exact: true }).fill(`Birthday ${unique}`);
      await campaign.getByRole("button", { name: "Save draft", exact: true }).click();
      await expect(campaign).not.toBeVisible();
      await page.reload();
      await page
        .getByRole("button", { name: "Campaigns and automations", exact: true })
        .first()
        .click();
      await page
        .getByRole("button")
        .filter({ has: page.getByText(`Birthday ${unique}`, { exact: true }) })
        .click();
      const editor = page.getByRole("dialog");
      await expect(editor.getByLabel("When to send", { exact: true })).toHaveValue("birthday");
      await editor.getByRole("button", { name: "Review recipients", exact: true }).click();
      const review = page.getByRole("dialog", { name: "Review recipients", exact: true });
      await expect(review.getByText(/Delivery is unavailable/)).toBeVisible();
      await expect(
        review.getByRole("button", { name: "Activate automation", exact: true }),
      ).toBeDisabled();
      await expectNoSeriousA11yViolations(page, `Marketing review ${scheme}`);
      await page.screenshot({
        path: `/tmp/citame-marketing-${scheme}-${info.project.name}.png`,
        fullPage: true,
      });
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.goto("/admin/settings?section=booking");
      const bookingLink = page.getByRole("link", { name: "Online booking", exact: true });
      await expect(bookingLink).toHaveAttribute("aria-current", "page");
      await page.reload();
      const notice = page.getByLabel("Minimum notice (minutes)", { exact: true });
      await notice.fill("180");
      await page.getByRole("link", { name: "Reminders", exact: true }).click();
      await expect(page).toHaveURL(/section=reminders/);
      await expect(bookingLink).not.toHaveAttribute("aria-current", "page");
      await page.goBack();
      await expect(page).toHaveURL(/section=booking/);
      await expect(notice).toHaveValue("180");
      await expectNoSeriousA11yViolations(page, `Settings ${scheme}`);
      await page.screenshot({
        path: `/tmp/citame-management-${scheme}-${info.project.name}.png`,
        fullPage: true,
      });
    });
  });
}
