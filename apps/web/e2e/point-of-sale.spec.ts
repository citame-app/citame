import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { reportSummarySchema } from "@sob/contracts";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import {
  at,
  expectNoHorizontalScroll,
  freeHour,
  runDays,
  STYLIST_A,
  salonDate,
} from "./admin-helpers";
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
        path: info.outputPath("receipt.png"),
        fullPage: true,
      });
    });
  });
}

test("the team occupancy report shows scheduled capacity and exports it", async ({ page }) => {
  const from = salonDate(7);
  const to = salonDate(14);
  const route = `/admin/reports?preset=custom&from=${from}&to=${to}`;
  await signInThroughUi(page, fixture.ownerEmail, route);
  const report = page.getByRole("region", { name: "Team occupancy" });
  await expect(
    report.getByText("Reserved in shift").filter({ visible: true }).first(),
  ).toBeVisible();
  await expectNoHorizontalScroll(page);
  const exporting = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export CSV", exact: true }).click();
  const csv = await readFile(await (await exporting).path(), "utf8");
  expect(csv).toContain(
    "staff,scheduled_minutes,blocked_minutes,reserved_minutes,completed_visit_minutes,no_show_minutes,occupancy_rate",
  );
  expect(csv).toMatch(/,\d{3,},0,0,0,0,0\.0000\r\n/);

  const summaryPath = "/api/admin/reports/summary";
  const initial = reportSummarySchema.parse(
    await (await page.request.get(`${summaryPath}?from=${from}&to=${to}`)).json(),
  );
  const member = initial.perStaff.find((row) => (row.occupancy?.scheduledMinutes ?? 0) > 0);
  if (!member?.occupancy) throw new Error("No scheduled member in the fixture");
  const { scheduledMinutes } = member.occupancy;
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === summaryPath,
  );
  const blocks = `/api/admin/staff/${member.staffId}/time-off`;
  const headers = { Origin: fixture.baseURL };
  const block = await page.request.post(blocks, {
    headers,
    data: {
      startsAt: `${salonDate(6)}T00:00:00.000Z`,
      endsAt: `${salonDate(16)}T00:00:00.000Z`,
    },
  });
  expect(block.status(), await block.text()).toBe(201);
  const {
    timeOff: { id },
  } = await block.json();
  try {
    const updated = reportSummarySchema.parse(await (await refreshed).json());
    expect(updated.perStaff.find((row) => row.staffId === member.staffId)?.occupancy).toMatchObject(
      {
        scheduledMinutes,
        blockedMinutes: scheduledMinutes,
        occupancyRate: null,
      },
    );
    await expect(
      report
        .getByText(new Intl.NumberFormat("en").format(scheduledMinutes), { exact: true })
        .filter({ visible: true })
        .nth(1),
    ).toBeVisible();
  } finally {
    expect((await page.request.delete(`${blocks}/${id}`, { headers })).status()).toBe(200);
  }
});

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

  await page.goto(`/admin/clients/${clientId}`);
  await page.getByRole("button", { name: "Payments", exact: true }).click();
  await page.getByRole("link", { name: "Client sales report" }).click();
  await expect(page).toHaveURL(new RegExp(`client=${clientId}`));
  await expect(page.getByRole("heading", { name: clientName })).toBeVisible();
  const byFamily = page.getByRole("table", { name: "Settled amounts by sale family" });
  const saleRow = byFamily.getByRole("row").filter({ hasText: "Custom items" });
  await expect(saleRow.getByRole("cell").first()).toHaveText("€123.45");
  await expectNoHorizontalScroll(page);
  const exportingSales = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export financial summary (CSV)" }).click();
  const scopedDownload = await exportingSales;
  expect(scopedDownload.suggestedFilename()).toContain(`client-sales-${clientId}-`);
  const salesCsv = await readFile(await scopedDownload.path(), "utf8");
  expect(salesCsv).toContain(`"client_id","${clientId}"`);
  expect(salesCsv).toContain('"custom","12345","0","EUR"');
  const professionalSelect = page.getByLabel("Professional");
  const professionalOption = professionalSelect.locator("option").nth(1);
  await expect(professionalOption).toBeAttached();
  const professional = await professionalOption.getAttribute("value");
  expect(professional).toBeTruthy();
  await page.getByLabel("From date").fill(from);
  await page.getByLabel("To date").fill(to);
  await professionalSelect.selectOption(professional ?? "");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(new RegExp(`from=${from}`));
  await expect(page).toHaveURL(new RegExp(`staff=${professional}`));
  await page.reload();
  await expect(page.getByLabel("From date")).toHaveValue(from);
  await expect(page.getByLabel("To date")).toHaveValue(to);
  await expect(professionalSelect).toHaveValue(professional ?? "");
  await page.goBack();
  await expect(professionalSelect).toHaveValue("");
  await expect(saleRow.getByRole("cell").first()).toHaveText("€123.45");
  await page.getByRole("link", { name: "Back to client profile" }).click();
  await expect(page.getByRole("heading", { name: clientName })).toBeVisible();
});

test("reads the existing partial receipt and removes the row after the last payment", async ({
  page,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, "/admin/commerce");
  await expect(page).toHaveURL(/\/admin\/commerce/);
  const headers = { Origin: fixture.baseURL };
  const clientId = crypto.randomUUID();
  const customer = `Partial receipt ${clientId.slice(0, 8)}`;
  const createdClient = await page.request.post("/api/admin/clients", {
    headers,
    data: { id: clientId, name: customer },
  });
  expect(createdClient.status(), await createdClient.text()).toBe(201);

  const [date] = runDays(1);
  if (!date) throw new Error("A synthetic booking date is required");
  const hour = await freeHour(date);
  const appointmentId = crypto.randomUUID();
  const booking = await page.request.post("/api/appointments", {
    headers,
    data: {
      id: appointmentId,
      staffId: STYLIST_A,
      clientId,
      serviceIds: [fixture.haircut],
      startsAt: at(date, `${String(hour).padStart(2, "0")}:00`),
      override: true,
    },
  });
  expect(booking.status(), await booking.text()).toBe(201);
  const createdReceipt = await page.request.post("/api/admin/commerce/checkouts", {
    headers,
    data: { appointmentId, idempotencyKey: crypto.randomUUID() },
  });
  expect(createdReceipt.status(), await createdReceipt.text()).toBe(201);
  const { id, totalCents } = await createdReceipt.json();
  expect(totalCents).toBe(2000);
  const payment = (amountCents: number) =>
    page.request.post(`/api/admin/commerce/checkouts/${id}/payments`, {
      headers,
      data: { method: "external_card", amountCents, idempotencyKey: crypto.randomUUID() },
    });
  expect((await payment(400)).status()).toBe(201);

  await page.getByRole("button", { name: "To collect", exact: true }).click();
  await page.getByLabel("Appointment date", { exact: true }).fill(date);
  const row = page.getByRole("listitem").filter({ hasText: customer });
  await expect(row).toContainText("Confirmed payments");
  await expect(row).toContainText("€4");
  await expect(row).toContainText("Remaining on receipt");
  await expect(row).toContainText("€16");
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, "Partial receipt in To collect");
  const readReceipt = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/admin/commerce/checkouts/${id}`) &&
      response.request().method() === "GET",
  );
  const open = row.getByRole("button", { name: "Open receipt", exact: true });
  await open.focus();
  await open.press("Enter");
  expect((await readReceipt).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`checkout=${id}`));
  expect((await payment(1600)).status()).toBe(201);
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(row).toHaveCount(0);
});
