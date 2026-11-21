import { expect, test } from "@playwright/test";
import { clientPhotoFixture } from "../../api/test/client-photo-fixture";
import { asOwner, expectNoHorizontalScroll, OWNER_EMAIL, signInAs } from "./admin-helpers";
import { expectNoSeriousA11yViolations, PASSWORD } from "./helpers";
import { addCatalogProduct, reviewReceipt } from "./pos-helpers";

test("a numbered stock receipt survives an interrupted response without recording the delivery twice", async ({
  page,
}) => {
  const owner = await asOwner();
  const tag = crypto.randomUUID();
  const products = [`Cream ${tag}`, `Serum ${tag}`];
  const productIds = new Map<string, string>();
  try {
    for (const name of products) {
      const created = await owner.post("/api/admin/inventory/products", {
        data: { name, priceCents: 2000, openingStock: 0, idempotencyKey: crypto.randomUUID() },
      });
      expect(created.status(), await created.text()).toBe(201);
      productIds.set(name, (await created.json()).id);
    }
    await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=inventory");
    await page.getByRole("button", { name: "Suppliers", exact: true }).click();
    await page.getByRole("button", { name: "New supplier", exact: true }).click();
    const supplier = `Care Lab ${tag}`;
    await page.getByLabel("Supplier name").fill(supplier);
    await page.getByLabel("Supplier email").fill("orders@example.org");
    await page.getByRole("button", { name: "Save supplier", exact: true }).click();
    await expect(page.getByRole("button", { name: supplier, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Stock receipts", exact: true }).click();
    await page.getByRole("button", { name: "New stock receipt" }).click();
    await page.getByLabel("Search suppliers").fill(supplier);
    await page
      .getByLabel("Supplier", { exact: true })
      .selectOption({ label: `${supplier} · orders@example.org` });
    await page.getByLabel("Supplier invoice reference").fill(`INV-${tag}`);
    for (const name of products) {
      await page.getByLabel("Search products", { exact: true }).fill(name);
      await page.getByLabel("Add a product", { exact: true }).selectOption(productIds.get(name)!);
      await page
        .getByRole("group", { name: new RegExp(name) })
        .getByLabel("Quantity")
        .fill("2");
    }
    const attempts: unknown[] = [];
    await page.context().route("**/api/admin/inventory/receipts", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      attempts.push(route.request().postDataJSON());
      if (attempts.length > 1) return route.continue();
      const committed = await route.fetch();
      expect(committed.status(), await committed.text()).toBe(201);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Record stock receipt" }).click();
    await expect(page.getByRole("button", { name: "Retry the same stock receipt" })).toBeEnabled();
    const url = page.url();
    const context = page.context();
    await page.close();
    const resumed = await context.newPage();
    await resumed.goto(url);
    await expect(
      resumed.getByRole("button", { name: "Stock receipts", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await resumed.getByRole("button", { name: "New stock receipt" }).click();
    await resumed.getByRole("button", { name: "Retry the same stock receipt" }).click();
    await expect(resumed.getByRole("heading", { name: /Stock receipt #\d+/ })).toBeVisible();
    await expect(resumed).toHaveURL(/inventoryTab=receipts.*receipt=/);
    await expect(resumed.getByText(`INV-${tag}`, { exact: false })).toBeVisible();
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const stock = await owner.get(`/api/admin/inventory/products?search=${tag}`);
    expect(stock.status()).toBe(200);
    expect(
      (await stock.json()).products.map((item: { stockOnHand: number }) => item.stockOnHand),
    ).toEqual([2, 2]);
    await expectNoHorizontalScroll(resumed);
  } finally {
    await owner.dispose();
  }
});

test("purchase orders recover an interrupted draft and link partial deliveries to inventory", async ({
  page,
}) => {
  const owner = await asOwner();
  const tag = crypto.randomUUID();
  const supplier = `Procurement ${tag}`;
  const name = `Lotion ${tag}`;
  const url = "/admin/commerce?view=inventory&inventoryTab=orders";
  try {
    const productResponse = await owner.post("/api/admin/inventory/products", {
      data: { name, priceCents: 2000, openingStock: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(productResponse.status(), await productResponse.text()).toBe(201);
    const product = await productResponse.json();
    const supplierId = crypto.randomUUID();
    const supplierResponse = await owner.put(`/api/admin/inventory/suppliers/${supplierId}`, {
      data: {
        name: supplier,
        email: null,
        phone: null,
        taxId: null,
        notes: null,
        active: true,
        version: 0,
        generation: product.inventoryGeneration,
      },
    });
    expect(supplierResponse.status(), await supplierResponse.text()).toBe(200);
    await signInAs(page, OWNER_EMAIL, url);
    await page.getByRole("button", { name: "New purchase order" }).click();
    await page.getByLabel("Search suppliers").fill(supplier);
    await page.getByLabel("Supplier", { exact: true }).selectOption(supplierId);
    await page.getByLabel("Supplier order reference").fill(`PO-${tag}`);
    await page.getByLabel("Search products", { exact: true }).fill(name);
    await page.getByLabel("Add a product", { exact: true }).selectOption(product.id);
    await page.getByLabel("Quantity", { exact: true }).fill("5");
    const requests: unknown[] = [];
    await page.context().route("**/api/admin/inventory/orders/*", async (route) => {
      if (route.request().method() !== "PUT" || route.request().postDataJSON().action !== "save")
        return route.continue();
      requests.push(route.request().postDataJSON());
      if (requests.length > 1) return route.continue();
      const saved = await route.fetch();
      expect(saved.status(), await saved.text()).toBe(200);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry purchase order request" });
    await expect(retry).toBeEnabled();
    await page.reload();
    await retry.click();
    const heading = page.getByRole("heading", { name: /Purchase order #\d+/ });
    await expect(heading).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const orderUrl = page.url();
    const observer = await page.context().newPage();
    await observer.goto(orderUrl);
    await expect(observer.getByText(`${supplier} · Draft`, { exact: true })).toBeVisible();
    const place = page.getByRole("button", { name: "Mark as ordered", exact: true });
    await place.click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Mark as ordered", exact: true })
      .click();
    await expect(observer.getByText(`${supplier} · Ordered`, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Record a delivery", exact: true }).click();
    await page.getByLabel("Quantity", { exact: true }).fill("2");
    await page.getByLabel("Supplier invoice reference").fill(`PARTIAL-${tag}`);
    await page.getByRole("button", { name: "Record stock receipt", exact: true }).click();
    await expect(page.getByRole("heading", { name: /Stock receipt #\d+/ })).toBeVisible();
    await expect(observer.getByText("Received: 2 · Remaining: 3", { exact: false })).toBeVisible();
    await observer.close();
    await page.getByRole("button", { name: "Open linked purchase order" }).click();
    await expect(page.getByText("Received: 2 · Remaining: 3", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Stock receipt #\d+/ })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await page.getByRole("button", { name: "Cancel outstanding order", exact: true }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Cancel outstanding order", exact: true })
      .click();
    await expect(page.getByText(`${supplier} · Cancelled`)).toBeVisible();
    await expect(page.getByRole("button", { name: /Stock receipt #\d+/ })).toBeVisible();
    const stock = await owner.get(`/api/admin/inventory/products/${product.id}`);
    expect(stock.status()).toBe(200);
    expect((await stock.json()).stockOnHand).toBe(2);
  } finally {
    await owner.dispose();
  }
});

test("warehouse transfers survive lost responses and keep checkout stock in the main warehouse", async ({
  page,
}) => {
  const owner = await asOwner();
  const name = `Room ${crypto.randomUUID()}`;
  const productName = `Warehouse serum ${crypto.randomUUID()}`;
  try {
    const productResponse = await owner.post("/api/admin/inventory/products", {
      data: {
        name: productName,
        priceCents: 1200,
        openingStock: 5,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(productResponse.status(), await productResponse.text()).toBe(201);
    const product = await productResponse.json();
    await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=inventory&inventoryTab=warehouses");
    await page.getByRole("button", { name: "New warehouse", exact: true }).click();
    await page.getByLabel("Warehouse name", { exact: true }).fill(name);
    await page.getByRole("button", { name: "Save warehouse", exact: true }).click();
    const warehouse = page.getByLabel("Warehouse", { exact: true });
    await expect(warehouse.locator("option:checked")).toHaveText(name);
    const destinationId = await warehouse.inputValue();
    await warehouse.selectOption("main");
    await page.getByRole("button", { name: "New transfer", exact: true }).click();
    await page.getByLabel("Destination warehouse", { exact: true }).selectOption(destinationId);
    await page.getByLabel("Reason", { exact: true }).fill("Synthetic stock transfer");
    await page.getByLabel("Search products", { exact: true }).fill(productName);
    await page.getByLabel("Add a product", { exact: true }).selectOption(product.id);
    await page.getByLabel("Quantity", { exact: true }).fill("3");
    await expectNoHorizontalScroll(page);
    const requests: unknown[] = [];
    await page.context().route("**/api/admin/inventory/transfers/*", async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      requests.push(route.request().postDataJSON());
      if (requests.length > 1) return route.continue();
      const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200);
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "Record transfer", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry this transfer", exact: true });
    await expect(retry).toBeVisible();
    await page.reload();
    await retry.click();
    await expect(page.getByRole("heading", { name: "Stock transfer", exact: true })).toBeVisible();
    await expect(page.getByText(`Main warehouse → ${name}`, { exact: true })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    const current = await owner.get(`/api/admin/inventory/products/${product.id}`);
    expect(await current.json()).toMatchObject({
      stockOnHand: 5,
      stockAllocated: 3,
      sellableAvailable: 2,
    });

    await page.getByRole("button", { name: "Stock movements", exact: true }).click();
    await page.getByLabel("Stock movement", { exact: true }).selectOption("transfer");
    await page.getByLabel("Warehouse", { exact: true }).selectOption(destinationId);
    const ledgerItem = page.getByRole("listitem").filter({ hasText: productName });
    await expect(ledgerItem).toHaveCount(1);
    await expect(ledgerItem.getByText("+3", { exact: true })).toBeVisible();
    await ledgerItem.getByRole("button", { name: "View transfer", exact: true }).click();
    await expect(page.getByText(`Main warehouse → ${name}`, { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await page.getByRole("button", { name: "Stock receipts", exact: true }).click();
    await page.getByRole("button", { name: "New stock receipt", exact: true }).click();
    await page.getByLabel("Receive into", { exact: true }).selectOption(destinationId);
    await page.getByLabel("Search products", { exact: true }).fill(productName);
    await page.getByLabel("Add a product", { exact: true }).selectOption(product.id);
    await page.getByLabel("Quantity", { exact: true }).fill("2");
    await page.getByRole("button", { name: "Record stock receipt", exact: true }).click();
    await expect(page.getByText(`Warehouse · ${name}`, { exact: true })).toBeVisible();
    const afterDelivery = await owner.get(`/api/admin/inventory/products/${product.id}`);
    expect(await afterDelivery.json()).toMatchObject({
      stockOnHand: 7,
      stockAllocated: 5,
      sellableAvailable: 2,
    });
  } finally {
    await owner.dispose();
  }
});

test("a stale saved warehouse transfer can be reviewed after reloading", async ({ page }) => {
  const owner = await asOwner();
  const suffix = crypto.randomUUID();
  const name = `Recovery serum ${suffix}`;
  const warehouse = `Recovery room ${suffix}`;
  try {
    const created = await owner.post("/api/admin/inventory/products", {
      data: { name, priceCents: 1200, openingStock: 5, idempotencyKey: crypto.randomUUID() },
    });
    expect(created.status(), await created.text()).toBe(201);
    const product = await created.json();
    const location = crypto.randomUUID();
    const saved = await owner.put(`/api/admin/inventory/warehouses/${location}`, {
      data: { name: warehouse, active: true, generation: product.inventoryGeneration, version: 0 },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=inventory&inventoryTab=warehouses");
    await page.getByRole("button", { name: "New transfer", exact: true }).click();
    await page.getByLabel("Destination warehouse").selectOption(location);
    await page.getByLabel("Reason").fill("Recover the staged transfer");
    await page.getByLabel("Search products").fill(name);
    await page.getByLabel("Add a product").selectOption(product.id);
    await page.getByLabel("Quantity", { exact: true }).fill("3");
    const pattern = "**/api/admin/inventory/transfers/*";
    await page.route(pattern, (route) =>
      route.request().method() === "PUT" ? route.abort("failed") : route.continue(),
    );
    await page.getByRole("button", { name: "Record transfer", exact: true }).click();
    const retry = page.getByRole("button", { name: "Retry this transfer" });
    await expect(retry).toBeVisible();
    await page.unroute(pattern);
    const receipt = await owner.post(`/api/admin/inventory/products/${product.id}/movements`, {
      data: {
        kind: "receive",
        quantity: 1,
        generation: product.inventoryGeneration,
        version: product.version,
        reason: "Concurrent delivery",
        idempotencyKey: crypto.randomUUID(),
      },
    });
    expect(receipt.status(), await receipt.text()).toBe(201);
    await page.reload();
    await retry.click();
    await page.getByRole("button", { name: "Review current stock", exact: true }).click();
    await expect(page.getByLabel("Reason")).toHaveValue("Recover the staged transfer");
    await expect(page.getByLabel("Quantity", { exact: true })).toHaveValue("3");
    await expect(page.getByText("Available in this warehouse: 6")).toBeVisible();
    await page.getByRole("button", { name: "Record transfer", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Stock transfer", exact: true })).toBeVisible();
    const actual = await owner.get(`/api/admin/inventory/products/${product.id}`);
    expect(await actual.json()).toMatchObject({
      stockOnHand: 6,
      stockAllocated: 3,
      sellableAvailable: 3,
    });
  } finally {
    await owner.dispose();
  }
});

test("stock movement pages stay in place until the operator loads the latest entries", async ({
  page,
}) => {
  const owner = await asOwner();
  const name = `Ledger ${crypto.randomUUID()}`;
  try {
    const created = await owner.post("/api/admin/inventory/products", {
      data: { name, priceCents: 2000, openingStock: 0, idempotencyKey: crypto.randomUUID() },
    });
    expect(created.status(), await created.text()).toBe(201);
    let product = await created.json();
    const receive = async (number: number) => {
      const result = await owner.post(`/api/admin/inventory/products/${product.id}/movements`, {
        data: {
          kind: "receive",
          quantity: 1,
          reason: `Stock receipt ${number}`,
          version: product.version,
          generation: product.inventoryGeneration,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      expect(result.status(), await result.text()).toBe(201);
      product = await result.json();
    };
    for (let index = 1; index <= 26; index++) await receive(index);

    await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=inventory");
    await page.getByRole("button", { name: "Stock movements", exact: true }).click();
    const search = page.getByLabel("Search movements", { exact: true });
    await search.fill(name);
    await page.getByLabel("Stock movement", { exact: true }).selectOption("receive");
    const csv = page.getByRole("link", { name: "Download movements CSV" });
    await expect(csv).toHaveAttribute("href", /anchor=/);
    const previous = page.getByRole("button", { name: "Previous page", exact: true });
    const fetchedPage = Promise.withResolvers<void>();
    const releasePage = Promise.withResolvers<void>();
    let held = false;
    await page.route("**/api/admin/inventory/movements?*", async (route) => {
      const { searchParams } = new URL(route.request().url());
      if (held || searchParams.get("page") !== "2") return route.continue();
      held = true;
      try {
        const response = await route.fetch();
        fetchedPage.resolve();
        await releasePage.promise;
        await route.fulfill({ response }).catch(() => {
          // The live revision intentionally cancels the obsolete request.
        });
      } catch (error) {
        fetchedPage.reject(error);
      }
    });
    try {
      await page.getByRole("button", { name: "Next page", exact: true }).click();
      await fetchedPage.promise;
      await receive(27);
      await expect(
        page.getByText("New stock movements are available.", { exact: true }),
      ).toBeVisible();
    } finally {
      releasePage.resolve();
    }
    await expect(page.getByText("Stock receipt 1", { exact: true })).toBeVisible();
    await expect(page.getByText("Stock receipt 2", { exact: true })).toHaveCount(0);

    const result = await owner.get(
      `/api/admin/inventory/movements/export?${new URL((await csv.getAttribute("href")) ?? "", page.url()).searchParams}`,
    );
    expect(result.status(), await result.text()).toBe(200);
    const body = await result.text();
    expect(body.trimEnd().split("\r\n")).toHaveLength(27);
    expect(body).not.toContain("Stock receipt 27");

    await page.getByRole("button", { name: "Manage product", exact: true }).click();
    await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
    await expect(search).toHaveValue(name);
    await expect(page.getByText("Stock receipt 1", { exact: true })).toBeVisible();
    await expect(previous).toBeEnabled();

    await page.getByRole("button", { name: "Show latest movements", exact: true }).click();
    await expect(page.getByText("Stock receipt 27", { exact: true })).toBeVisible();
    await expect(previous).toBeDisabled();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "stock movement pagination");
  } finally {
    await owner.dispose();
  }
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`retail inventory — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("product creation, stock delivery, sale, physical return and archive", async ({
      page,
    }) => {
      const unique = crypto.randomUUID();
      const name = `Repair shampoo ${unique}`;
      const productCard = page
        .getByRole("listitem")
        .filter({ has: page.getByText(name, { exact: true }) });
      await signInAs(page, OWNER_EMAIL, "/admin/commerce");
      await page.getByRole("button", { name: "Inventory", exact: true }).click();
      await page.getByRole("button", { name: "New product", exact: true }).click();
      await page.getByLabel("Product name", { exact: true }).fill(name);
      await page.getByLabel("SKU (optional)", { exact: true }).fill(`SH-${unique}`);
      await page.getByLabel("Sale price (EUR)", { exact: true }).fill("20.00");
      await page.getByLabel("Unit cost (EUR)", { exact: true }).fill("7.00");
      await page.getByLabel("Included tax (%)", { exact: true }).fill("21");
      await page.getByLabel("Opening stock", { exact: true }).fill("3");
      await page.getByLabel("Low stock threshold", { exact: true }).fill("1");
      await page.getByRole("button", { name: "Save product", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Stock history", exact: true })).toBeVisible();
      const photoInput = page.getByLabel("Choose a product photo", { exact: true });
      const imageBytes = await clientPhotoFixture();
      const upload = {
        name: "synthetic-product.jpg",
        mimeType: "image/jpeg",
        buffer: imageBytes,
      };
      await photoInput.setInputFiles(upload);
      const savePhoto = page.getByRole("button", { name: "Save photo", exact: true });
      await savePhoto.click();
      const photo = page.getByRole("img", { name, exact: true });
      await expect(photo).toBeVisible();
      await expect
        .poll(() => photo.evaluate((img) => (img as HTMLImageElement).naturalWidth))
        .toBeGreaterThan(0);
      if (scheme === "light") {
        const currentUrl = (await photo.getAttribute("src"))!;
        await photoInput.setInputFiles(upload);
        const write = await page.request.put(currentUrl.replace(/\/[^/]+$/, ""), {
          headers: { origin: new URL(page.url()).origin },
          data: {
            version: currentUrl.split("/").at(-1),
            imageBase64: imageBytes.toString("base64"),
          },
        });
        expect(write.status(), await write.text()).toBe(200);
        await expect(photo).not.toHaveAttribute("src", currentUrl);
        await expect(
          page.getByText("The photo changed. Check the current photo and try again."),
        ).toBeVisible();
        await expect(savePhoto).toBeDisabled();
        await page.getByRole("button", { name: "Keep my selected file", exact: true }).click();
        const saved = page.waitForResponse(
          (response) => response.request().method() === "PUT" && response.url().endsWith("/photo"),
        );
        await savePhoto.click();
        const applied = await saved;
        expect(applied.status(), await applied.text()).toBe(200);
        expect((await applied.json()).version).not.toBe((await write.json()).version);
        await expect(photo).toHaveAttribute(
          "src",
          new RegExp(`/${(await applied.json()).version}$`),
        );
        await expect(savePhoto).toBeDisabled();
      }
      const oldPhotoUrl = (await photo.getAttribute("src"))!;
      await page.getByRole("button", { name: "Remove photo", exact: true }).click();
      await expect(photo).toHaveCount(0);
      expect((await page.request.get(oldPhotoUrl)).status()).toBe(404);
      await page.getByLabel("Quantity", { exact: true }).fill("2");
      await page.getByLabel("Reason", { exact: true }).fill("Supplier delivery E2E");
      const sent: unknown[] = [];
      if (scheme === "light") {
        await page.route("**/api/admin/inventory/products/*/movements", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          sent.push(route.request().postDataJSON());
          if (sent.length > 1) return route.continue();
          const committed = await route.fetch();
          expect(committed.status(), await committed.text()).toBe(201);
          await route.abort("failed");
        });
      }
      await page.getByRole("button", { name: "Record stock movement", exact: true }).click();
      if (scheme === "light") {
        const retry = page.getByRole("button", { name: "Retry the same movement", exact: true });
        await expect(retry).toBeEnabled();
        await page.reload();
        await page.getByLabel("Search products", { exact: true }).fill(unique);
        await expect(productCard.getByText("Available: 5", { exact: true })).toBeVisible();
        await productCard.getByRole("button", { name: "Manage product", exact: true }).click();
        await expect(page.getByLabel("Quantity", { exact: true })).toBeDisabled();
        await retry.click();
        await expect(retry).toHaveCount(0);
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual(sent[0]);
      }
      await expect(page.getByText("Supplier delivery E2E", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
      await page.getByLabel("Search products", { exact: true }).fill(unique);
      await expect(productCard.getByText("Available: 5", { exact: true })).toBeVisible();
      await page.getByLabel("Sort by", { exact: true }).selectOption("updated_desc");
      await page.getByLabel("Products per page", { exact: true }).selectOption("50");
      await expect(
        page.getByText("Sorted by Last updated. Total results 1.", { exact: true }),
      ).toBeAttached();
      await expect(page.getByRole("link", { name: "Download stock CSV" })).toHaveAttribute(
        "href",
        /sort=updated_desc/,
      );
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `inventory catalog ${scheme}`);
      await page.getByRole("button", { name: "Back to sales", exact: true }).click();
      await page.getByRole("button", { name: "New sale", exact: true }).click();
      await addCatalogProduct(page, name, unique);
      await page.getByLabel("Quantity", { exact: true }).fill("2");
      await reviewReceipt(page);
      const receipt = page.getByRole("region", { name: "Receipt", exact: true });
      await expect(receipt.getByText(name)).toBeVisible();
      await receipt.getByLabel("Payment method", { exact: true }).selectOption("external_card");
      await receipt.getByRole("button", { name: "Record payment", exact: true }).click();
      await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
      await receipt.getByText("Return product to stock", { exact: true }).first().click();
      await receipt.getByLabel("Reason", { exact: true }).fill("Unopened customer return");
      await receipt.getByRole("button", { name: "Return product to stock", exact: true }).click();
      await expect(receipt.getByText("Product returned to stock", { exact: true })).toBeVisible();
      await expectNoHorizontalScroll(page);
      await expectNoSeriousA11yViolations(page, `inventory receipt ${scheme}`);
      const owner = await asOwner();
      try {
        const response = await owner.get(`/api/admin/inventory/products?search=${unique}`);
        const data = await response.json();
        const product = data.products[0];
        expect(product.stockOnHand).toBe(4);
        expect(product.stockReserved).toBe(0);
        const archived = await owner.patch(`/api/admin/inventory/products/${product.id}`, {
          data: { active: false, version: product.version },
        });
        expect(archived.ok(), await archived.text()).toBe(true);
      } finally {
        await owner.dispose();
      }
    });
  });
}

test("reception can inspect product history from the catalog and ledger with read-only access", async ({
  page,
}) => {
  const unique = crypto.randomUUID();
  const name = `Test shampoo ${unique}`;
  const email = `inventory-${unique}@example.com`;
  const owner = await asOwner();
  try {
    const account = await owner.post("/api/admin/staff-accounts", {
      data: { email, name: "Test reception", displayName: "Test reception", password: PASSWORD },
    });
    expect(account.ok(), await account.text()).toBe(true);
    const { staffId } = await account.json();
    const accessPath = `/api/admin/staff/${staffId}/access`;
    const access = await (await owner.get(accessPath)).json();
    const role = await owner.put(accessPath, {
      data: { preset: "receptionist", version: access.version },
    });
    expect(role.ok(), await role.text()).toBe(true);
    const created = await owner.post("/api/admin/inventory/products", {
      data: {
        name,
        sku: `TEST-${unique}`,
        priceCents: 2000,
        costCents: 700,
        openingStock: 8,
        storageLocation: "Cabinet 2",
        idempotencyKey: unique,
      },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const product = await created.json();
    await signInAs(page, email, "/admin/commerce?view=inventory");
    const search = page.getByLabel("Search products");
    await search.fill(unique);
    const open = page.getByRole("button", { name: `View product ${name}` });
    await open.press("Enter");
    const heading = page.getByRole("heading", { name, level: 2 });
    await expect(heading).toBeFocused();
    await expect(page.getByText("Cabinet 2", { exact: true })).toBeVisible();
    await expect(page.getByText("Opening stock", { exact: true })).toBeVisible();
    await expect(page.getByText("Unit cost (EUR)", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Save product", exact: true })).toHaveCount(0);
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "read-only inventory details");
    await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
    await expect(open).toBeFocused();
    await expect(search).toHaveValue(unique);

    await page.getByRole("button", { name: "Stock movements", exact: true }).click();
    const ledgerSearch = page.getByLabel("Search movements");
    await ledgerSearch.fill(unique);
    await open.click();
    await expect(heading).toBeVisible();
    await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
    await expect(ledgerSearch).toHaveValue(unique);
    const refused = await page.request.patch(`/api/admin/inventory/products/${product.id}`, {
      data: { priceCents: 10, version: product.version },
    });
    expect(refused.status()).toBe(403);
  } finally {
    await owner.dispose();
  }
});

test("a live catalogue refresh does not interrupt saving a brand", async ({ page }) => {
  const owner = await asOwner();
  const pattern = "**/api/admin/inventory/classifications";
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  try {
    const catalogue = await owner.get("/api/admin/inventory/classifications");
    expect(catalogue.status()).toBe(200);
    const { generation } = await catalogue.json();
    await signInAs(
      page,
      OWNER_EMAIL,
      "/admin/commerce?view=inventory&inventoryTab=classifications",
    );
    await page.getByRole("button", { name: "New brand", exact: true }).click();
    const editor = page.getByRole("form", { name: "Edit classification" });
    const name = `New brand ${crypto.randomUUID()}`;
    await editor.getByLabel("Name", { exact: true }).fill(name);
    await page.route(pattern, async (route) => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      await route.continue();
    });
    const otherBrandResponse = await owner.put(
      `/api/admin/inventory/classifications/${crypto.randomUUID()}`,
      {
        data: {
          name: `Other brand ${crypto.randomUUID()}`,
          kind: "brand",
          parentId: null,
          active: true,
          position: 0,
          version: 0,
          generation,
        },
      },
    );
    expect(otherBrandResponse.status(), await otherBrandResponse.text()).toBe(200);
    await refreshStarted.promise;
    const submitted = page.waitForResponse(
      (response) =>
        response.url().includes("/api/admin/inventory/classifications/") &&
        response.request().method() === "PUT",
    );
    const submit = editor.getByRole("button", { name: "Save classification", exact: true });
    await Promise.all([submit.click({ timeout: 5_000 }), submitted]);
    expect((await submitted).status()).toBe(200);
    releaseRefresh.resolve();
    await expect(page.getByText(name, { exact: true })).toBeVisible();
  } finally {
    releaseRefresh.resolve();
    await owner.dispose();
  }
});

test("a rejected classification draft requires review even while the catalogue refreshes", async ({
  page,
}) => {
  const owner = await asOwner();
  const pattern = "**/api/admin/inventory/classifications";
  const refreshStarted = Promise.withResolvers<void>();
  const releaseRefresh = Promise.withResolvers<void>();
  try {
    const catalogue = await owner.get("/api/admin/inventory/classifications");
    expect(catalogue.status()).toBe(200);
    const { generation } = await catalogue.json();
    const id = crypto.randomUUID();
    const url = `/api/admin/inventory/classifications/${id}`;
    const name = `Brand ${id}`;
    const fields = { name, kind: "brand", parentId: null, active: true, position: 0, generation };
    const created = await owner.put(url, { data: { ...fields, version: 0 } });
    expect(created.status(), await created.text()).toBe(200);
    const { version } = await created.json();
    await signInAs(
      page,
      OWNER_EMAIL,
      "/admin/commerce?view=inventory&inventoryTab=classifications",
    );
    await page.getByRole("button", { name: `Edit classification · ${name}`, exact: true }).click();
    const editor = page.getByRole("form", { name: "Edit classification" });
    const editedName = `${name} edited`;
    await editor.getByLabel("Name", { exact: true }).fill(editedName);
    await page.route(pattern, async (route) => {
      refreshStarted.resolve();
      await releaseRefresh.promise;
      await route.continue();
    });
    const updated = await owner.put(url, { data: { ...fields, position: 42, version } });
    expect(updated.status(), await updated.text()).toBe(200);
    await refreshStarted.promise;
    const submit = editor.getByRole("button", { name: "Save classification", exact: true });
    const [rejection] = await Promise.all([
      page.waitForResponse((response) => response.url().endsWith(url)),
      submit.click({ timeout: 5_000 }),
    ]);
    expect(rejection.status()).toBe(409);
    await expect(editor.getByRole("status")).toBeVisible();
    await expect(submit).toBeDisabled();
    releaseRefresh.resolve();
    await editor.getByRole("button", { name: "Use current version and keep my changes" }).click();
    await expect(editor.getByLabel("Name", { exact: true })).toHaveValue(editedName);
    await expect(editor.getByRole("spinbutton")).toHaveValue("42");
    await submit.click();
    await expect(page.getByText(editedName, { exact: true })).toBeVisible();
  } finally {
    releaseRefresh.resolve();
    await owner.dispose();
  }
});

test("inventory categories, subcategories and brands can be assigned and filtered", async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const parent = `Care ${suffix}`;
  const child = `Colour ${suffix}`;
  const brand = `Lab ${suffix}`;
  const product = `Serum ${suffix}`;
  await signInAs(page, OWNER_EMAIL, "/admin/commerce?view=inventory&inventoryTab=classifications");
  const newCategory = page.getByRole("button", { name: "New category", exact: true });
  const editor = page.getByRole("form", { name: "Edit classification" });
  const submit = editor.getByRole("button", { name: "Save classification", exact: true });
  await newCategory.click();
  await editor.getByLabel("Name", { exact: true }).fill(parent);
  await submit.click();
  await expect(page.getByText(parent, { exact: true })).toBeVisible();
  await newCategory.click();
  await editor.getByLabel("Name", { exact: true }).fill(child);
  await editor.getByLabel("Parent category", { exact: true }).selectOption({ label: parent });
  await submit.click();
  await expect(page.getByText(child, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "New brand", exact: true }).click();
  await editor.getByLabel("Name", { exact: true }).fill(brand);
  await submit.click();
  await expect(page.getByText(brand, { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Product catalog", exact: true }).click();
  await page.getByRole("button", { name: "New product", exact: true }).click();
  await page.getByLabel("Product name", { exact: true }).fill(product);
  await page.getByLabel("Sale price (EUR)", { exact: true }).fill("15");
  await page.getByRole("button", { name: "Assign from catalogue", exact: true }).click();
  const choices = page.getByRole("group", { name: "Categories and brands" });
  await choices.getByLabel("Category", { exact: true }).selectOption({ label: parent });
  await choices.getByLabel("Subcategory", { exact: true }).selectOption({ label: child });
  await choices.getByLabel("Brand", { exact: true }).selectOption({ label: brand });
  await page.getByRole("button", { name: "Save product", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Product details", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to inventory", exact: true }).click();
  await page
    .getByLabel("Subcategory", { exact: true })
    .selectOption({ label: `${parent} / ${child}` });
  await expect(page.getByRole("heading", { name: product, exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
