import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";
import { addCustomItem, reviewReceipt } from "./pos-helpers";

async function openRewards(page: Page) {
  await page.goto("/admin/commerce");
  await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
  await page.getByRole("button", { name: "Loyalty & promotions", exact: true }).click();
}
async function newCustomerSale(page: Page, description: string, clientId: string) {
  await page.getByRole("button", { name: "New sale", exact: true }).click();
  await page.getByRole("button", { name: "Select a customer or leave blank", exact: true }).click();
  await page
    .getByLabel("Search by name, phone or email", { exact: true })
    .fill(fixture.clientEmail);
  await page
    .getByRole("dialog", { name: "Select a customer", exact: true })
    .getByRole("button")
    .filter({ hasText: fixture.clientEmail })
    .click();
  await addCustomItem(page, description, "100.00");
  const created = page.waitForResponse(
    (r) => r.url().endsWith("/api/admin/commerce/checkouts") && r.request().method() === "POST",
  );
  await reviewReceipt(page);
  const response = await created;
  expect(response.status(), await response.text()).toBe(201);
  const sale = await response.json();
  expect(sale.clientId).toBe(clientId);
  await expect(
    page.getByRole("region", { name: "Receipt", exact: true }).getByText(description),
  ).toBeVisible();
  return sale.id as string;
}
for (const scheme of ["light", "dark"] as const) {
  test.describe(`loyalty and promotions — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("configures, credits, previews, spends and returns points with private customer history and bounded coupons", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const created: string[] = [];
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const clients = await (
          await owner.get(`/api/admin/clients?search=${fixture.clientEmail}`)
        ).json();
        const client = clients.clients.find(
          (c: { email: string }) => c.email === fixture.clientEmail,
        );
        if (!client) throw new Error("Missing fixture customer");
        const before = await (await owner.get(`/api/admin/rewards/clients/${client.id}`)).json();
        const current = await (await owner.get("/api/admin/rewards/policy")).json();
        expect(
          (
            await owner.put("/api/admin/rewards/policy", {
              data: {
                ...current,
                enabled: false,
                earnEveryCents: 100,
                pointsPerStep: 1,
                maximumDiscountBasisPoints: 2000,
              },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/commerce");
        await page.getByRole("button", { name: "Gift cards & rewards", exact: true }).click();
        await page.getByRole("button", { name: "Loyalty & promotions", exact: true }).click();
        await page.getByLabel("Discount value per point (EUR)", { exact: true }).fill("0.10");
        await page
          .getByRole("checkbox", { name: "Enable earning and redeeming points", exact: true })
          .check();
        await page.getByRole("button", { name: "Save points program", exact: true }).click();
        await expect(page.getByText("Points program saved", { exact: true })).toBeVisible();
        await page
          .getByLabel("Search customer for points", { exact: true })
          .fill(fixture.clientEmail);
        await page.getByLabel("Customer points account", { exact: true }).selectOption(client.id);
        await page.getByLabel("Points to add or remove", { exact: true }).fill("100");
        await page
          .getByLabel("Adjustment or return reason", { exact: true })
          .fill("Browser fixture customer credit");
        await page.getByRole("button", { name: "Record point adjustment", exact: true }).click();
        await expect(page.getByText("Point adjustment recorded", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `loyalty program ${scheme}`);
        await page.getByRole("button", { name: "Back to sales", exact: true }).click();
        const description = `Loyalty visit ${crypto.randomUUID()}`;
        const saleId = await newCustomerSale(page, description, client.id);
        created.push(saleId);
        const receipt = page.getByRole("region", { name: "Receipt", exact: true });
        await receipt.locator("summary").filter({ hasText: "Loyalty & promotions" }).click();
        await receipt.getByLabel("Reward type", { exact: true }).selectOption("points");
        await receipt.getByLabel("Points to use", { exact: true }).fill("100");
        await receipt.getByRole("button", { name: "Preview discount", exact: true }).click();
        await expect(receipt.getByText("Save €10 · New total €90", { exact: true })).toBeVisible();
        await receipt.getByRole("button", { name: "Apply this discount", exact: true }).click();
        await expect(receipt.getByText("Points used: 100", { exact: true })).toBeVisible();
        await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
        await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
        await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(page, fixture.clientEmail, "/account/rewards");
        await page.getByRole("button", { name: "Loyalty & promotions", exact: true }).click();
        const available = page
          .locator("dl > div")
          .filter({ has: page.getByText("Available points", { exact: true }) })
          .locator("dd");
        await expect(available).toHaveText(
          new Intl.NumberFormat("en").format(before.availablePoints + 90),
        );
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `customer point history ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-loyalty-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
        });
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(
          page,
          fixture.ownerEmail,
          `/admin/commerce?view=transactions&checkout=${saleId}`,
        );
        await receipt.getByRole("button", { name: "Refund payment", exact: true }).click();
        await receipt.getByLabel("Refund amount", { exact: true }).fill("90.00");
        await receipt
          .getByLabel("Refund reason", { exact: true })
          .fill("Entire fixture service returned");
        await receipt.getByRole("button", { name: "Confirm refund request", exact: true }).click();
        await expect(
          receipt.getByText("Points returned: 100. Original validity still applies.", {
            exact: true,
          }),
        ).toBeVisible();
        const returned = await (await owner.get(`/api/admin/rewards/clients/${client.id}`)).json();
        expect(returned).toMatchObject({
          availablePoints: before.availablePoints + 100,
          reservedPoints: 0,
        });
        await openRewards(page);
        const offer = `Welcome offer ${crypto.randomUUID()}`;
        const code = `WELCOME_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
        await page.getByRole("button", { name: "New promotion", exact: true }).click();
        await page.getByLabel("Offer name", { exact: true }).fill(offer);
        await page
          .getByLabel("Code (letters, numbers, hyphen or underscore)", { exact: true })
          .fill(code);
        await page.getByLabel("Discount (% or EUR)", { exact: true }).fill("10");
        await page.getByLabel("Total uses (empty: unlimited)", { exact: true }).fill("1");
        await page.getByRole("button", { name: "Save promotion", exact: true }).click();
        await expect(page.getByText("Promotion saved", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `promotion editor ${scheme}`);
        await page.getByRole("button", { name: "Back to sales", exact: true }).click();
        const promoSale = await newCustomerSale(
          page,
          `Promotion visit ${crypto.randomUUID()}`,
          client.id,
        );
        created.push(promoSale);
        await receipt.locator("summary").filter({ hasText: "Loyalty & promotions" }).click();
        await receipt.getByLabel("Promotion code", { exact: true }).fill(code);
        await receipt.getByRole("button", { name: "Preview discount", exact: true }).click();
        await expect(receipt.getByText("Save €10 · New total €90", { exact: true })).toBeVisible();
        await receipt.getByRole("button", { name: "Apply this discount", exact: true }).click();
        await expect(receipt.getByText(offer, { exact: true })).toBeVisible();
        await receipt.locator("summary").filter({ hasText: "Void unpaid checkout" }).click();
        await receipt.getByRole("button", { name: "Void unpaid checkout", exact: true }).click();
        await expect(receipt.getByRole("status").filter({ hasText: /^Voided$/ })).toBeVisible();
        const promotions = await (
          await owner.get(`/api/admin/rewards/promotions?search=${code}`)
        ).json();
        expect(promotions.promotions[0]).toMatchObject({ code, usageLimit: 1, usedCount: 0 });
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `released coupon ${scheme}`);
      } finally {
        for (const id of created) {
          const sale = await (await owner.get(`/api/admin/commerce/checkouts/${id}`)).json();
          if (sale.status === "open" && !sale.payments?.length)
            await owner.post(`/api/admin/commerce/checkouts/${id}/void`, { data: {} });
        }
        const current = await (await owner.get("/api/admin/rewards/policy")).json();
        await owner.put("/api/admin/rewards/policy", { data: { ...current, enabled: false } });
        await owner.dispose();
      }
    });
  });
}
