import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  productListSchema,
  productPhotoVersionSchema,
  productSchema,
  stockLedgerSchema,
} from "@sob/contracts";
import { retailProduct } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let staff: Actor;
let client: Actor;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
async function product(extra: Record<string, unknown> = {}) {
  const response = await call(owner, "/admin/inventory/products", "POST", {
    name: "Repair shampoo",
    sku: "SHAMPOO-250",
    priceCents: 2000,
    costCents: 700,
    taxBasisPoints: 2100,
    openingStock: 5,
    lowStockThreshold: 2,
    idempotencyKey: crypto.randomUUID(),
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as {
    id: string;
    name: string;
    version: number;
    stockOnHand: number;
    stockReserved: number;
    available: number;
    inventoryGeneration: string;
    costCents?: number | null;
  };
}
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "inventory" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await seedFixtures(t.db);
  [owner, staff, client] = await Promise.all([
    actor(t, "owner", "stock-owner@example.com"),
    actor(t, "staff", "stock-staff@example.com"),
    actor(t, "client", "stock-client@example.com"),
  ]);
});

test("owner creates catalog stock, staff see availability but not costs, clients cannot read inventory", async () => {
  const item = await product();
  expect(item).toMatchObject({ stockOnHand: 5, stockReserved: 0, available: 5, costCents: 700 });
  const listed = (await (await call(staff, "/admin/inventory/products")).json()) as {
    products: Record<string, unknown>[];
  };
  expect(listed.products).toHaveLength(1);
  expect(listed.products[0]?.costCents).toBeUndefined();
  expect(listed.products[0]?.canManage).toBe(false);
  const ownerDetail = await call(owner, `/admin/inventory/products/${item.id}`);
  expect(productSchema.parse(await ownerDetail.json()).canManage).toBe(true);
  expect((await call(client, "/admin/inventory/products")).status).toBe(403);
  expect((await call(null, "/admin/inventory/products")).status).toBe(401);
  expect(
    (
      await call(staff, "/admin/inventory/products", "POST", {
        name: "Invalid",
        sku: "BAD",
        priceCents: 100,
      })
    ).status,
  ).toBe(403);
});

test("product photos are private, normalized and protected against stale writes", async () => {
  const item = await product();
  const productPath = `/admin/inventory/products/${item.id}`;
  const path = `${productPath}/photo`;
  const source = await sharp({
    create: { width: 64, height: 32, channels: 3, background: "#87556a" },
  })
    .png()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const input = { version: null, imageBase64: source.toString("base64") };
  expect((await call(staff, path, "PUT", input)).status).toBe(403);
  expect((await call(owner, path, "PUT", { ...input, imageBase64: "YWJj" })).status).toBe(400);
  const attempts = await Promise.all([
    call(owner, path, "PUT", input),
    call(owner, path, "PUT", input),
  ]);
  expect(attempts.map((result) => result.status).sort()).toEqual([200, 409]);
  const { version } = productPhotoVersionSchema.parse(await attempts.find((row) => row.ok)!.json());
  if (!version) throw new Error("Product photo creation returned no version");
  const url = `${path}/${version}`;
  expect((await call(null, url)).status).toBe(401);
  expect((await call(client, url)).status).toBe(403);
  const image = await call(staff, url);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(image.headers.get("cache-control")).toBe("private, no-store");
  const metadata = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
  expect(metadata).toMatchObject({ format: "jpeg", width: 32, height: 64 });
  expect(metadata.exif).toBeUndefined();
  const detail = productSchema.parse(await (await call(staff, productPath)).json());
  expect(detail.photoVersion).toBe(version);
  expect(detail.costCents).toBeUndefined();
  const list = productListSchema.parse(
    await (await call(staff, "/admin/inventory/products")).json(),
  );
  expect(list.products.find((row) => row.id === item.id)?.photoVersion).toBe(version);
  const replacement = productPhotoVersionSchema.parse(
    await (await call(owner, path, "PUT", { ...input, version })).json(),
  );
  expect(replacement.version).not.toBe(version);
  expect((await call(staff, url)).status).toBe(404);
  expect((await call(owner, path, "PUT", { version, imageBase64: null })).status).toBe(409);
  const remove = await call(owner, path, "PUT", {
    version: replacement.version,
    imageBase64: null,
  });
  expect(await remove.json()).toEqual({ version: null });
  expect((await call(staff, `${path}/${replacement.version}`)).status).toBe(404);
  expect(
    productSchema.parse(await (await call(staff, productPath)).json()).photoVersion,
  ).toBeUndefined();
});

test("package content is optional, versioned and independent of stock", async () => {
  const item = await product();
  const path = `/admin/inventory/products/${item.id}`;
  const read = async () => productSchema.parse(await (await call(staff, path)).json());
  expect((await read()).packageContent).toBeNull();
  const invalid = await call(owner, path, "PATCH", {
    version: item.version,
    packageContent: { quantity: "0", unit: "ml" },
  });
  expect(invalid.status).toBe(400);
  expect(
    (
      await call(owner, path, "PATCH", {
        version: item.version,
        packageContent: { quantity: "12.5", unit: "m\u0000l" },
      })
    ).status,
  ).toBe(400);
  const input = { version: item.version, packageContent: { quantity: "12.50", unit: "ml" } };
  expect((await call(staff, path, "PATCH", input)).status).toBe(403);
  expect((await call(owner, path, "PATCH", input)).status).toBe(200);
  expect((await call(owner, path, "PATCH", input)).status).toBe(409);
  const saved = await read();
  expect(saved).toMatchObject({
    packageContent: { quantity: "12.5", unit: "ml" },
    stockOnHand: 5,
    stockReserved: 0,
  });
  expect(
    (await call(owner, path, "PATCH", { version: saved.version, name: "Updated" })).status,
  ).toBe(200);
  const renamed = await read();
  expect(renamed.packageContent).toEqual(saved.packageContent);
  expect(
    (await call(owner, path, "PATCH", { version: renamed.version, packageContent: null })).status,
  ).toBe(200);
  expect(await read()).toMatchObject({ packageContent: null, stockOnHand: 5 });
});

test("product creation replays the same package content without adding stock twice", async () => {
  const fields = {
    idempotencyKey: crypto.randomUUID(),
    packageContent: { quantity: "12,500", unit: "ml" },
  };
  const first = await product(fields);
  const replay = await product({ ...fields, packageContent: { quantity: "12.5", unit: "ml" } });
  expect(replay).toMatchObject({
    id: first.id,
    stockOnHand: 5,
    packageContent: { quantity: "12.5", unit: "ml" },
  });
});
test("inventory reports and downloads use all filtered rows with exact values and role-based costs", async () => {
  const known = await product({
    name: '=HYPERLINK("example")',
    category: "Hair",
    costCents: 999999999,
    openingStock: 999999999,
    packageContent: { quantity: "12.50", unit: "ml" },
  });
  await t.db.update(retailProduct).set({ stockReserved: 2 }).where(eq(retailProduct.id, known.id));
  await product({ sku: "UNKNOWN", category: "Hair", costCents: null, openingStock: 1 });
  await product({ sku: "OTHER", category: "Skin" });
  await t.db.insert(retailProduct).values(
    Array.from({ length: 500 }, (_, index) => ({
      name: "Shared name across export batches",
      sku: `BATCH-${index}`,
      category: "Hair",
      priceCents: 0,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "synthetic-export-test",
    })),
  );
  const productsPath = "/admin/inventory/products";
  const filters = "?category=Hair&pageSize=1&page=2";
  const report = await call(owner, `${productsPath}/report${filters}`);
  expect(report.status).toBe(200);
  const counts = {
    products: 502,
    onHand: 1000000000,
    reserved: 2,
    lowStockProducts: 501,
  };
  expect(await report.json()).toEqual({
    ...counts,
    valuation: { currency: "EUR", knownCostCents: "999999998000000001", productsMissingCost: 1 },
  });
  expect(await (await call(staff, `${productsPath}/report${filters}`)).json()).toEqual(counts);
  expect((await call(client, `${productsPath}/report${filters}`)).status).toBe(403);

  const csv = await call(owner, `${productsPath}/export${filters}`);
  expect(csv.status).toBe(200);
  expect(csv.headers.get("content-disposition")).toContain("attachment");
  expect(csv.headers.get("cache-control")).toBe("private, no-store");
  const lines = (await csv.text()).trimEnd().split("\r\n");
  expect(lines).toHaveLength(503);
  expect(new Set(lines.slice(1).map((line) => line.split(",")[0])).size).toBe(502);
  expect(lines[0]).toContain('"known_stock_value_cents"');
  expect(lines.some((line) => line.includes(`"'=HYPERLINK(""example"")"`))).toBe(true);
  expect(lines[0]).toEndWith('"package_content_quantity","package_content_unit"');
  expect(lines.some((line) => line.endsWith('"999999998000000001","12.5","ml"'))).toBe(true);
  expect(lines.some((line) => line.startsWith('"OTHER"'))).toBe(false);
  const staffCsv = await (await call(staff, `${productsPath}/export${filters}`)).text();
  expect(staffCsv).not.toContain("unit_cost_cents");
  expect(staffCsv).not.toContain("999999998000000001");
  expect(staffCsv).toContain('"12.5","ml"');
  const head = await call(staff, `${productsPath}/export${filters}`, "HEAD");
  expect(head.status).toBe(200);
  expect(await head.text()).toBe("");
  expect((await call(client, `${productsPath}/export${filters}`)).status).toBe(403);

  await t.db.execute(sql`
    update retail_product
    set updated_at = '2026-07-03T12:00:00.123001Z'::timestamptz
      + (case when sku like 'BATCH-%' then substring(sku from 7)::int else 500 end)
        * interval '1 microsecond'
    where category = 'Hair'
  `);
  const sorted = "?category=Hair&sort=updated_desc&pageSize=2";
  const first = productListSchema.parse(await (await call(owner, productsPath + sorted)).json());
  const second = productListSchema.parse(
    await (await call(owner, productsPath + sorted + "&page=2")).json(),
  );
  const sku = (result: { products: { sku: string }[] }) => result.products.map((row) => row.sku);
  expect(new Set(sku(first))).toEqual(new Set(["SHAMPOO-250", "UNKNOWN"]));
  expect(sku(second)).toEqual(["BATCH-499", "BATCH-498"]);
  const sortedCsv = await (await call(owner, `${productsPath}/export${sorted}&page=2`)).text();
  const exported = sortedCsv
    .trimEnd()
    .split("\r\n")
    .slice(1)
    .map((line) => line.split(",")[0]);
  expect(exported).toEqual(
    [...sku(first), ...Array.from({ length: 500 }, (_, index) => `BATCH-${499 - index}`)].map(
      (value) => `"${value}"`,
    ),
  );
  const byName = productListSchema.parse(
    await (await call(owner, `${productsPath}?category=Hair&sort=name_desc&pageSize=1`)).json(),
  );
  expect(byName.products[0]?.name).toBe("Shared name across export batches");
  const byAvailable = productListSchema.parse(
    await (await call(staff, `${productsPath}?category=Hair&sort=stock_asc&pageSize=1`)).json(),
  );
  expect(byAvailable.products[0]?.available).toBe(0);
  expect((await call(owner, `${productsPath}?sort=unit_cost`)).status).toBe(400);
});

test("movement CSV keeps microsecond cursors, matches both filters and hides restricted costs", async () => {
  const item = await product();
  await t.db.execute(sql`
    insert into stock_movement (
      id, product_id, quantity_delta, kind, reason, unit_cost_cents,
      idempotency_key, request_hash, created_at
    )
    select gen_random_uuid(), ${item.id}::uuid, -1, 'consume', '=2+2 inventory test', 321,
      'export-test-' || seq, 'synthetic-export-test',
      '2026-03-09T12:00:00Z'::timestamptz + seq * interval '1 microsecond'
    from generate_series(1, 501) as batch(seq)
  `);
  const common = "/admin/inventory/movements";
  const filters = "?kind=consume&search=inventory%20test&pageSize=1&page=2";
  const list = await call(owner, common + filters);
  expect(list.headers.get("cache-control")).toBe("private, no-store");
  expect(await list.json()).toMatchObject({
    pagination: { total: 501 },
    movements: [{ kind: "consume", unitCostCents: 321 }],
  });
  const response = await call(owner, `${common}/export${filters}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-disposition")).toContain("citame-stock-movements.csv");
  const [heading, ...rows] = (await response.text()).trimEnd().split("\r\n");
  expect(heading).toContain("unit_cost_cents");
  expect(rows).toHaveLength(501);
  expect(new Set(rows.map((row) => row.split(",")[1])).size).toBe(501);
  expect(rows[0]).toStartWith('"2026-03-09T12:00:00.000501Z"');
  expect(rows.at(-1)).toStartWith('"2026-03-09T12:00:00.000001Z"');
  expect(rows.every((row) => row.includes(`"'=2+2 inventory test"`) && row.endsWith('"321"'))).toBe(
    true,
  );
  const missing = await call(owner, `${common}/export?kind=opening&search=inventory%20test`);
  expect((await missing.text()).trimEnd().split("\r\n")).toHaveLength(1);
  const staffCsv = await (await call(staff, `${common}/export${filters}`)).text();
  expect(staffCsv).not.toContain("unit_cost_cents");
  expect(staffCsv.trimEnd().split("\r\n")).toHaveLength(502);
  const staffList = stockLedgerSchema.parse(await (await call(staff, common + filters)).json());
  expect(staffList.movements).toHaveLength(1);
  expect(staffList.movements[0]).not.toHaveProperty("unitCostCents");
  expect((await call(client, common + filters)).status).toBe(403);
  expect((await call(client, `${common}/export${filters}`)).status).toBe(403);
});

test("ledger pages and CSV exclude both later and earlier-started transactions that commit after opening", async () => {
  const item = await product();
  const add = async (sequence: number, micros: number, db: Pick<typeof t.db, "execute"> = t.db) =>
    db.execute(sql`
      insert into stock_movement (
        id, product_id, quantity_delta, kind, reason, idempotency_key, request_hash, created_at
      ) values (
        ${`00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`}::uuid,
        ${item.id}::uuid, -1, 'consume', ${`Anchored ledger ${sequence}`},
        ${`anchor-test-${sequence}`}, 'synthetic',
        '2026-03-09T12:00:00Z'::timestamptz + ${micros} * interval '1 microsecond'
      )
    `);
  await add(1, 1);
  const path = "/admin/inventory/movements";
  const filters = "search=Anchored%20ledger&kind=consume&pageSize=1";
  const inserted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const late = t.db.transaction(async (tx) => {
    await add(4, 0, tx);
    inserted.resolve();
    await release.promise;
  });
  let anchor: string;
  try {
    await Promise.race([inserted.promise, late]);
    await add(2, 2);
    const first = stockLedgerSchema.parse(await (await call(owner, `${path}?${filters}`)).json());
    expect(first).toMatchObject({
      movements: [{ reason: "Anchored ledger 2" }],
      anchor: expect.stringMatching(/^[A-Za-z0-9_-]+~\d+$/),
      hasNewer: false,
    });
    anchor = first.anchor!;
    await add(3, 2);
  } finally {
    release.resolve();
    await late;
  }
  expect(
    await (await call(owner, `${path}?${filters}&page=2&anchor=${anchor}`)).json(),
  ).toMatchObject({
    movements: [{ reason: "Anchored ledger 1" }],
    pagination: { total: 2 },
    hasNewer: true,
  });
  expect(await (await call(owner, `${path}?${filters}&anchor=${anchor}`)).json()).toMatchObject({
    movements: [{ reason: "Anchored ledger 2" }],
  });
  expect(await (await call(owner, `${path}?${filters}`)).json()).toMatchObject({
    movements: [{ reason: "Anchored ledger 3" }],
    pagination: { total: 4 },
  });
  const csv = await (await call(owner, `${path}/export?${filters}&anchor=${anchor}`)).text();
  expect(csv).toContain("Anchored ledger 2");
  expect(csv).toContain("Anchored ledger 1");
  expect(csv).not.toContain("Anchored ledger 3");
  expect(csv).not.toContain("Anchored ledger 4");
  expect((await call(owner, `${path}?${filters}&anchor=invalid`)).status).toBe(400);
  expect((await call(owner, `${path}?${filters}&anchor=initial~9223372036854775808`)).status).toBe(
    400,
  );
  for (const endpoint of [path, `${path}/export`]) {
    const stale = await call(owner, `${endpoint}?${filters}&anchor=previous-generation~1`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  }
});

test("stock receipts, usage, counts and version conflicts are auditable and idempotent", async () => {
  const item = await product();
  const key = crypto.randomUUID();
  const body = {
    kind: "receive",
    quantity: 3,
    reason: "Supplier delivery",
    version: item.version,
    idempotencyKey: key,
    generation: item.inventoryGeneration,
  };
  const first = await call(owner, `/admin/inventory/products/${item.id}/movements`, "POST", body);
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ stockOnHand: 8 });
  expect(
    (await call(owner, `/admin/inventory/products/${item.id}/movements`, "POST", body)).status,
  ).toBe(201);
  expect(
    (
      await call(owner, `/admin/inventory/products/${item.id}/movements`, "POST", {
        ...body,
        quantity: 4,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(owner, `/admin/inventory/products/${item.id}`, "PATCH", {
        version: item.version,
        priceCents: 2200,
      })
    ).status,
  ).toBe(409);
  const view = (await (
    await call(owner, `/admin/inventory/products/${item.id}`)
  ).json()) as typeof item;
  expect(
    (
      await call(owner, `/admin/inventory/products/${item.id}/movements`, "POST", {
        kind: "consume",
        quantity: 9,
        reason: "Salon use",
        version: view.version,
        generation: view.inventoryGeneration,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(owner, `/admin/inventory/products/${item.id}/movements`, "POST", {
        kind: "count",
        quantity: 2,
        reason: "Physical count",
        version: view.version,
        generation: view.inventoryGeneration,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  const low = (await (await call(owner, "/admin/inventory/products?lowStock=true")).json()) as {
    products: unknown[];
  };
  expect(low.products).toHaveLength(1);
});

test("a reviewed inventory generation fences stock writes without changing their replay key", async () => {
  const item = await product();
  const path = `/admin/inventory/products/${item.id}`;
  const current = productSchema.parse(await (await call(owner, path)).json());
  const generation = current.inventoryGeneration;
  expect(generation).toBeTruthy();
  const command = {
    kind: "receive",
    quantity: 1,
    version: item.version,
    reason: "Reviewed delivery",
    idempotencyKey: crypto.randomUUID(),
  };
  const wrong = await call(owner, `${path}/movements`, "POST", {
    ...command,
    generation: `old-${crypto.randomUUID()}`,
  });
  expect(wrong.status).toBe(409);
  expect(await wrong.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  expect(await (await call(owner, path)).json()).toMatchObject({ stockOnHand: 5 });
  const wrongAccount = await call(owner, `${path}/movements`, "POST", {
    ...command,
    generation,
    actorUserId: staff.userId,
  });
  expect(wrongAccount.status).toBe(403);
  expect((await call(owner, `${path}/movements`, "POST", command)).status).toBe(400);
  expect(
    (
      await call(owner, `${path}/movements`, "POST", {
        ...command,
        generation,
        actorUserId: owner.userId,
      })
    ).status,
  ).toBe(201);
  const replay = await call(owner, `${path}/movements`, "POST", { ...command, generation });
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({ stockOnHand: 6, inventoryGeneration: generation });
  expect(await (await call(owner, `${path}/movements`)).json()).toMatchObject({
    inventoryGeneration: generation,
    pagination: { total: 2 },
  });
});
test("catalog identifiers are unique, edits preserve booked prices and archived products remain in history", async () => {
  const item = await product();
  expect(
    (
      await call(owner, "/admin/inventory/products", "POST", {
        name: "Duplicate",
        sku: "shampoo-250",
        priceCents: 1,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const changed = await call(owner, `/admin/inventory/products/${item.id}`, "PATCH", {
    version: item.version,
    active: false,
  });
  expect(changed.status).toBe(200);
  expect(
    (
      (await (await call(owner, "/admin/inventory/products?active=inactive")).json()) as {
        products: unknown[];
      }
    ).products,
  ).toHaveLength(1);
  expect(
    (
      (await (await call(owner, "/admin/inventory/products?active=active")).json()) as {
        products: unknown[];
      }
    ).products,
  ).toHaveLength(0);
});

test("catalog metadata, internal-use sales guard, facets and paginated stock ledger", async () => {
  const item = await product({
    sku: undefined,
    category: "Hair",
    brand: "Studio",
    targetStock: 12,
    resellable: false,
    description: "Backbar only",
  });
  const view = await (await call(owner, `/admin/inventory/products/${item.id}`)).json();
  expect(view).toMatchObject({
    category: "Hair",
    brand: "Studio",
    targetStock: 12,
    resellable: false,
    description: "Backbar only",
  });
  expect((view as { sku: string }).sku).toMatch(/^SKU-/);
  expect(await (await call(staff, "/admin/inventory/facets")).json()).toEqual({
    categories: ["Hair"],
    brands: ["Studio"],
  });
  expect(
    await (await call(owner, "/admin/inventory/products?resellable=true")).json(),
  ).toMatchObject({ products: [], pagination: { total: 0 } });
  expect(
    await (await call(owner, "/admin/inventory/products?category=Hair&brand=Studio")).json(),
  ).toMatchObject({ pagination: { total: 1 } });
  const sale = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "product", productId: item.id, quantity: 1 }],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(sale.status).toBe(409);
  const ledger = (await (
    await call(staff, "/admin/inventory/movements?kind=opening&search=Repair&pageSize=1")
  ).json()) as { movements: Record<string, unknown>[]; pagination: { total: number } };
  expect(ledger.pagination.total).toBe(1);
  expect(ledger.movements[0]).toMatchObject({
    productName: "Repair shampoo",
    quantityDelta: 5,
    kind: "opening",
  });
  expect(ledger.movements[0]?.unitCostCents).toBeUndefined();
  expect((await call(client, "/admin/inventory/movements")).status).toBe(403);
});
