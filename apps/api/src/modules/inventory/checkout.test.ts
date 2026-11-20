import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { expireInventoryHolds } from "./reservations";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
const call = (path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, owner.cookie);
const key = () => crypto.randomUUID();
async function item(stock = 5) {
  const response = await call("/admin/inventory/products", "POST", {
    name: "Repair shampoo",
    sku: `SKU-${key()}`,
    priceCents: 2000,
    costCents: 700,
    taxBasisPoints: 2100,
    openingStock: stock,
    lowStockThreshold: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; version: number };
}
const cart = (productId: string, quantity = 1, extra: Record<string, unknown> = {}) =>
  call("/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "product", productId, quantity }],
    idempotencyKey: key(),
    ...extra,
  });
const stock = async (id: string) =>
  (await (await call(`/admin/inventory/products/${id}`)).json()) as {
    id: string;
    version: number;
    stockOnHand: number;
    stockReserved: number;
    available: number;
    inventoryGeneration: string;
  };
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "inventory_checkout",
    env: {
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: "sq7HjrUOBfKmC576ILgskD5srU870gJ7",
      REDSYS_ENVIRONMENT: "test",
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await seedFixtures(t.db);
  owner = await actor(t, "owner", "inventory-pos@example.com");
});

test("concurrent carts reserve the last unit only once and cannot forge its price", async () => {
  const p = await item(1);
  const responses = await Promise.all([cart(p.id), cart(p.id)]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 1, stockReserved: 1, available: 0 });
  expect(
    (
      await call("/admin/commerce/checkouts", "POST", {
        lines: [{ kind: "product", productId: p.id, quantity: 1, unitAmountCents: 1 }],
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(400);
});
test("settlement consumes a reserved quantity once and later catalog edits cannot rewrite the receipt", async () => {
  const p = await item();
  const response = await cart(p.id, 2);
  expect(response.status, await response.clone().text()).toBe(201);
  const sale = (await response.json()) as {
    id: string;
    totalCents: number;
    lines: { id: string; unitAmountCents: number }[];
  };
  expect(sale.totalCents).toBe(4000);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 5, stockReserved: 2, available: 3 });
  const held = await stock(p.id);
  expect(
    (
      await call(`/admin/inventory/products/${p.id}`, "PATCH", {
        version: held.version,
        priceCents: 3000,
        active: false,
      })
    ).status,
  ).toBe(200);
  const paymentKey = key();
  const pay = () =>
    call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
      method: "external_card",
      amountCents: 4000,
      idempotencyKey: paymentKey,
    });
  expect((await pay()).status).toBe(201);
  expect((await pay()).status).toBe(201);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 3, stockReserved: 0, available: 3 });
  const receipt = (await (
    await call(`/admin/commerce/checkouts/${sale.id}`)
  ).json()) as typeof sale;
  expect(receipt.lines[0]?.unitAmountCents).toBe(2000);
  const moves = (await (await call(`/admin/inventory/products/${p.id}/movements`)).json()) as {
    movements: { kind: string; quantityDelta: number }[];
  };
  expect(moves.movements.filter((m) => m.kind === "sale")).toEqual([
    expect.objectContaining({ quantityDelta: -2 }),
  ]);
  const line = sale.lines[0];
  if (!line) throw new Error("Missing checkout line");
  const returnKey = key();
  const returned = {
    checkoutLineId: line.id,
    quantity: 1,
    reason: "Unopened customer return",
    idempotencyKey: returnKey,
  };
  expect((await call("/admin/inventory/returns", "POST", returned)).status).toBe(201);
  expect((await call("/admin/inventory/returns", "POST", returned)).status).toBe(201);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 4, stockReserved: 0 });
  expect(
    (
      await call("/admin/inventory/returns", "POST", {
        ...returned,
        quantity: 2,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(409);
});
test("a physical count cannot dispose of units already reserved for checkout", async () => {
  const p = await item(2);
  await cart(p.id, 2);
  const held = await stock(p.id);
  expect(
    (
      await call(`/admin/inventory/products/${p.id}/movements`, "POST", {
        kind: "count",
        quantity: 1,
        reason: "Physical count",
        version: held.version,
        generation: held.inventoryGeneration,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(409);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 2, stockReserved: 2 });
});
test("unpaid carts expire, while unresolved bank attempts retain their reservation", async () => {
  const p = await item(2);
  const first = (await (await cart(p.id)).json()) as { id: string };
  await t.db.execute(
    sql`update stock_reservation set expires_at = now() - interval '1 minute' where checkout_id = ${first.id}`,
  );
  expect(await expireInventoryHolds(t.db, new Date())).toBe(1);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 2, stockReserved: 0 });
  expect(
    ((await (await call(`/admin/commerce/checkouts/${first.id}`)).json()) as { status: string })
      .status,
  ).toBe("void");
  const second = (await (await cart(p.id)).json()) as { id: string };
  expect(
    (
      await call(`/admin/commerce/checkouts/${second.id}/payments`, "POST", {
        method: "redsys_card",
        amountCents: 2000,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(201);
  await t.db.execute(
    sql`update stock_reservation set expires_at = now() - interval '1 minute' where checkout_id = ${second.id}`,
  );
  expect(await expireInventoryHolds(t.db, new Date())).toBe(0);
  expect((await call(`/admin/commerce/checkouts/${second.id}/void`, "POST", {})).status).toBe(409);
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 2, stockReserved: 1 });
});
test("free product checkouts still consume stock and report the included tax correctly", async () => {
  const p = await item(1);
  const paid = await cart(p.id, 1, { discountCents: 2000 });
  expect(paid.status).toBe(201);
  expect(await paid.json()).toMatchObject({ status: "paid", totalCents: 0, taxCents: 0 });
  expect(await stock(p.id)).toMatchObject({ stockOnHand: 0, stockReserved: 0 });
});

test("voiding an unpaid cart releases its stock, while partial payments keep it reserved", async () => {
  const p = await item(2);
  const sale = (await (await cart(p.id)).json()) as { id: string };
  expect((await call(`/admin/commerce/checkouts/${sale.id}/void`, "POST", {})).status).toBe(200);
  expect((await call(`/admin/commerce/checkouts/${sale.id}/void`, "POST", {})).status).toBe(200);
  expect(await stock(p.id)).toMatchObject({ stockReserved: 0, stockOnHand: 2 });
  const next = (await (await cart(p.id)).json()) as { id: string };
  expect(
    (
      await call(`/admin/commerce/checkouts/${next.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 1000,
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(201);
  expect((await call(`/admin/commerce/checkouts/${next.id}/void`, "POST", {})).status).toBe(409);
  await t.db.execute(
    sql`update stock_reservation set expires_at = now() - interval '1 minute' where checkout_id = ${next.id}`,
  );
  expect(await expireInventoryHolds(t.db)).toBe(0);
  expect(await stock(p.id)).toMatchObject({ stockReserved: 1, stockOnHand: 2 });
});
test("duplicate product lines share availability and checkout exposes fulfillment without private costs", async () => {
  const p = await item(2);
  const request = {
    lines: [
      { kind: "product", productId: p.id, quantity: 1 },
      { kind: "product", productId: p.id, quantity: 2 },
    ],
    idempotencyKey: key(),
  };
  expect((await call("/admin/commerce/checkouts", "POST", request)).status).toBe(409);
  const sale = (await (await cart(p.id, 2, { discountCents: 4000 })).json()) as {
    fulfilledAt?: string;
    lines: Record<string, unknown>[];
  };
  expect(sale.fulfilledAt).toEqual(expect.any(String));
  expect(sale.lines[0]?.unitCostCents).toBeUndefined();
});
