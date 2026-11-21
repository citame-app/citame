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
