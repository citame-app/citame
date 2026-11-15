import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
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
test("stock receipts, usage, counts and version conflicts are auditable and idempotent", async () => {
  const item = await product();
  const key = crypto.randomUUID();
  const body = {
    kind: "receive",
    quantity: 3,
    reason: "Supplier delivery",
    version: item.version,
    idempotencyKey: key,
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
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  const low = (await (await call(owner, "/admin/inventory/products?lowStock=true")).json()) as {
    products: unknown[];
  };
  expect(low.products).toHaveLength(1);
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
