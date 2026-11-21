import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll, salonDate } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";
import { addCustomItem, closeReceipt, reviewReceipt } from "./pos-helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`point of sale — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("catalog basket, preserved draft, exact money, payment, searchable history and receipt link", async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await signInThroughUi(page, fixture.ownerEmail, "/admin/commerce");
      const posts: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.url().endsWith("/api/admin/commerce/checkouts"))
          posts.push(request.postData() ?? "");
      });
      const label = `POS ${crypto.randomUUID()}`;
      const basket = page.getByRole("complementary", { name: "Current receipt", exact: true });
      // Choosing catalog items is a local draft; no sale is created until payment review.
      await page.getByRole("button", { name: "Services", exact: true }).click();
      await page.getByRole("button", { name: /^Haircut / }).click();
      await basket.getByLabel("Quantity", { exact: true }).fill("2");
      await page.getByRole("button", { name: "Transactions", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      await expect(basket.getByLabel("Quantity", { exact: true })).toHaveValue("2");
      await addCustomItem(page, label, "12.50");
      await basket.locator("summary").click();
      await basket.getByLabel("Discount type", { exact: true }).selectOption("percent");
      await basket.getByLabel("Discount", { exact: true }).fill("10");
      await basket.getByLabel("Tip (EUR)", { exact: true }).fill("1.50");
      expect(posts).toHaveLength(0);
      const widths = info.project.name === "mobile" ? [320, 390] : [768, 820, 1024, 1440];
      for (const width of widths) {
        await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
        await expectNoHorizontalScroll(page);
      }
      await expectNoSeriousA11yViolations(page, `POS draft ${scheme}`);
      const created = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/admin/commerce/checkouts") &&
          response.request().method() === "POST",
      );
      await reviewReceipt(page);
      const response = await created;
      expect(response.status(), await response.text()).toBe(201);
      const checkout = await response.json();
      expect(checkout).toMatchObject({
        clientId: null,
        subtotalCents: 5250,
        discountCents: 525,
        tipCents: 150,
        totalCents: 4875,
      });
      expect(JSON.parse(posts[0]!).lines[0]).toEqual({
        kind: "service",
        serviceId: fixture.haircut,
        quantity: 2,
        taxBasisPoints: 0,
      });
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      await expectNoSeriousA11yViolations(page, `POS receipt ${scheme}`);
      await closeReceipt(page);
      await expect(basket.getByRole("heading", { name: "Your basket is empty" })).toBeVisible();
      await page.getByRole("button", { name: "Transactions", exact: true }).click();
      await page.getByLabel("Search by item or receipt number", { exact: true }).fill(label);
      await page.getByRole("button").filter({ hasText: label }).click();
      await expect(page).toHaveURL(new RegExp(`checkout=${checkout.id}`));
      await page.reload();
      await expect(receipt.getByRole("listitem").filter({ hasText: label })).toBeVisible();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      expect(errors).toEqual([]);
      await page.screenshot({
        path: `/tmp/citame-pos-${scheme}-${info.project.name}.png`,
        fullPage: true,
      });
    });
  });
}

test("client collections report shows and exports net payments", async ({ page }) => {
  const from = salonDate(-1);
  const to = salonDate(1);
  await signInThroughUi(
    page,
    fixture.ownerEmail,
    `/admin/reports?preset=custom&from=${from}&to=${to}`,
  );
  await expect(page).toHaveURL(/\/admin\/reports/);
  const headers = { Origin: fixture.baseURL };
  const clientId = crypto.randomUUID();
  const clientName = `Collections ${clientId}`;
  const client = await page.request.post("/api/admin/clients", {
    headers,
    data: { id: clientId, name: clientName },
  });
  expect(client.status(), await client.text()).toBe(201);
  const sale = await page.request.post("/api/admin/commerce/checkouts", {
    headers,
    data: {
      clientId,
      lines: [
        { kind: "custom", description: "Collections fixture", quantity: 1, unitAmountCents: 12345 },
      ],
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(sale.status(), await sale.text()).toBe(201);
  const { id: checkoutId } = await sale.json();
  const paid = await page.request.post(`/api/admin/commerce/checkouts/${checkoutId}/payments`, {
    headers,
    data: { method: "external_card", amountCents: 12345, idempotencyKey: crypto.randomUUID() },
  });
  expect(paid.status(), await paid.text()).toBe(201);
  const { payment } = await paid.json();
  await page
    .getByRole("navigation", { name: "Reports" })
    .getByRole("button", { name: "Clients" })
    .click();
  const ranking = page.getByRole("table", { name: "Top 10 clients by net collections" });
  const row = ranking.getByRole("row").filter({ hasText: clientName });
  await expect(row.getByRole("cell")).toHaveText("€123.45");

  const refund = await page.request.post(`/api/admin/commerce/payments/${payment.id}/refunds`, {
    headers,
    data: { amountCents: 2345, reason: "Fixture refund", idempotencyKey: crypto.randomUUID() },
  });
  expect(refund.status(), await refund.text()).toBe(201);

  await expect(row.getByRole("cell")).toHaveText("€100");
  await expectNoHorizontalScroll(page);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export net collections CSV" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(`client-net-collections-${from}-${to}.csv`);
  const csv = await readFile(await download.path(), "utf8");
  expect(csv).toMatch(/^client,net_cents,currency\r\n/);
  expect(csv).toContain(`${clientName},10000,EUR\r\n`);
});
