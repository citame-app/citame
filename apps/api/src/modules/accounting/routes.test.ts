import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  commissionPayoutSchema,
  reviewedCommissionPolicySchema,
  syncPullResponseSchema,
} from "@sob/contracts";
import { appointment, appointmentService, clientProfile } from "@sob/db";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let staff: Actor;
let other: Actor;
let client: Actor;
let appointmentId: string;
const key = () => crypto.randomUUID();
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
const statement = async (who = owner) =>
  (await (await call(who, `/admin/accounting/staff/${staff.staffId}/statement`)).json()) as {
    earnedCents: number;
    paidCents: number;
    outstandingCents: number;
    accruals: { rateBasisPoints: number; originalCents: number; adjustedCents: number }[];
  };
const policy = (
  serviceBasisPoints = 2500,
  productBasisPoints = 1000,
  version: number | null = null,
) =>
  call(owner, `/admin/accounting/staff/${staff.staffId}/policy`, "PUT", {
    serviceBasisPoints,
    productBasisPoints,
    version,
  });
async function sale(extra: Record<string, unknown> = {}) {
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    discountCents: 1000,
    tipCents: 500,
    idempotencyKey: key(),
    ...extra,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { id: string; totalCents: number };
}
async function settle(id: string, amountCents: number) {
  const response = await call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
    method: "external_card",
    amountCents,
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { payment: { id: string } }).payment;
}
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "accounting" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  const f = await seedFixtures(t.db);
  [owner, staff, other, client] = await Promise.all([
    actor(t, "owner", "accounts-owner@example.com"),
    actor(t, "staff", "accounts-staff@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "accounts-other@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "accounts-client@example.com"),
  ]);
  const [booking] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: client.clientId ?? f.clientId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    })
    .returning();
  if (!booking) throw new Error("Missing appointment");
  appointmentId = booking.id;
  await t.db.insert(appointmentService).values({
    appointmentId,
    serviceId: f.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10000,
    currency: "EUR",
  });
});
test("only owner sets commissions; staff see only their own statement", async () => {
  expect((await policy()).status).toBe(200);
  expect(
    (
      await call(staff, `/admin/accounting/staff/${staff.staffId}/policy`, "PUT", {
        serviceBasisPoints: 10000,
        productBasisPoints: 10000,
        version: 1,
      })
    ).status,
  ).toBe(403);
  expect((await call(other, `/admin/accounting/staff/${staff.staffId}/statement`)).status).toBe(
    403,
  );
  expect((await call(client, `/admin/accounting/staff/${staff.staffId}/statement`)).status).toBe(
    403,
  );
  expect((await call(staff, `/admin/accounting/staff/${staff.staffId}/statement`)).status).toBe(
    200,
  );
  expect((await policy(5000, 0, null)).status).toBe(409);
});
test("settlement snapshots discounted service commission, excludes tips and reverses refunds proportionally", async () => {
  await policy();
  const checkout = await sale();
  await settle(checkout.id, 4000);
  expect((await statement()).earnedCents).toBe(0);
  const payment = await settle(checkout.id, 5500);
  expect(await statement()).toMatchObject({
    earnedCents: 2250,
    outstandingCents: 2250,
    accruals: [expect.objectContaining({ originalCents: 2250, rateBasisPoints: 2500 })],
  });
  expect((await policy(5000, 2000, 1)).status).toBe(200);
  expect((await statement()).earnedCents).toBe(2250);
  const refund = await call(owner, `/admin/commerce/payments/${payment.id}/refunds`, "POST", {
    amountCents: 4750,
    reason: "Half of the sale returned",
    idempotencyKey: key(),
  });
  expect(refund.status).toBe(201);
  expect(await statement()).toMatchObject({
    earnedCents: 1125,
    accruals: [expect.objectContaining({ originalCents: 2250, adjustedCents: 1125 })],
  });
});
test("payout records are idempotent and later refunds carry a negative balance forward", async () => {
  await policy();
  const checkout = await sale({ discountCents: 0, tipCents: 0 });
  const payment = await settle(checkout.id, 10000);
  const payout = {
    amountCents: 2500,
    reference: "External bank transfer 123",
    idempotencyKey: key(),
  };
  const path = `/admin/accounting/staff/${staff.staffId}/payouts`;
  const review = reviewedCommissionPolicySchema.parse(
    await (await call(owner, `/admin/accounting/staff/${staff.staffId}/policy/reviewed`)).json(),
  );
  const reviewed = { ...payout, generation: review.generation, actorUserId: owner.userId };
  const cursor = syncPullResponseSchema.parse(
    await (await call(owner, "/sync/pull")).json(),
  ).nextCursor;
  const first = await call(owner, `${path}/reviewed`, "POST", reviewed);
  expect(first.status).toBe(201);
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  const firstBody: unknown = await first.json();
  expect(firstBody).toMatchObject({ idempotencyKey: payout.idempotencyKey });
  const recorded = commissionPayoutSchema.parse(firstBody);
  const refreshPath = `/sync/pull?since=${cursor}`;
  const changes = syncPullResponseSchema.parse(await (await call(owner, refreshPath)).json());
  expect(changes.refresh).toContain("commerce");
  expect(changes.changes).toEqual([]);
  const repeated = await call(owner, path, "POST", payout);
  expect(repeated.status).toBe(201);
  expect(commissionPayoutSchema.parse(await repeated.json())).toEqual(recorded);
  const anotherKey = { ...reviewed, idempotencyKey: key() };
  const duplicate = await call(owner, `${path}/reviewed`, "POST", anotherKey);
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: { code: "version_conflict" } });
  const matchRequest = { ...anotherKey, existingPayoutId: recorded.id };
  const matched = await call(owner, `${path}/reviewed`, "POST", matchRequest);
  expect(matched.status).toBe(200);
  const matchBody: unknown = await matched.json();
  expect(matchBody).toMatchObject({ idempotencyKey: matchRequest.idempotencyKey });
  expect(commissionPayoutSchema.parse(matchBody)).toEqual(recorded);
  expect(
    (await call(owner, `${path}/reviewed`, "POST", { ...matchRequest, amountCents: 2499 })).status,
  ).toBe(404);
  const replay = syncPullResponseSchema.parse(await (await call(owner, refreshPath)).json());
  expect(replay.nextCursor).toBe(changes.nextCursor);
  expect((await call(owner, path, "POST", { ...payout, amountCents: 2000 })).status).toBe(409);
  expect(
    (await call(owner, path, "POST", { ...payout, idempotencyKey: key(), amountCents: 1 })).status,
  ).toBe(409);
  expect(await statement()).toMatchObject({
    earnedCents: 2500,
    paidCents: 2500,
    outstandingCents: 0,
  });
  expect(
    (
      await call(owner, `/admin/commerce/payments/${payment.id}/refunds`, "POST", {
        amountCents: 10000,
        reason: "Full refund after payout",
        idempotencyKey: key(),
      })
    ).status,
  ).toBe(201);
  expect(await statement()).toMatchObject({
    earnedCents: 0,
    paidCents: 2500,
    outstandingCents: -2500,
  });
});
test("retail commissions exclude included tax and preserve costs and rate snapshots", async () => {
  await policy();
  const created = await call(owner, "/admin/inventory/products", "POST", {
    name: "Shampoo",
    sku: "SH-1",
    priceCents: 12100,
    costCents: 7000,
    taxBasisPoints: 2100,
    openingStock: 1,
    idempotencyKey: key(),
  });
  const product = (await created.json()) as { id: string };
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    staffId: staff.staffId,
    lines: [{ kind: "product", productId: product.id, quantity: 1 }],
    idempotencyKey: key(),
  });
  expect(response.status).toBe(201);
  const checkout = (await response.json()) as { id: string };
  await settle(checkout.id, 12100);
  expect((await statement()).earnedCents).toBe(1000);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
  const report = await call(owner, `/admin/accounting/sales?from=${date}&to=${date}`);
  expect(report.status).toBe(200);
  expect(await report.json()).toMatchObject({
    collectedCents: 12100,
    refundedCents: 0,
    soldCents: 12100,
    includedTaxCents: 2100,
    productCostCents: 7000,
    unknownCostLines: 0,
    settledByFamily: [{ family: "product", amountCents: 12100, taxCents: 2100 }],
  });
  expect((await call(staff, `/admin/accounting/sales?from=${date}&to=${date}`)).status).toBe(403);
  const otherReport = await call(
    owner,
    `/admin/accounting/sales?from=${date}&to=${date}&staffId=${other.staffId}`,
  );
  expect(await otherReport.json()).toMatchObject({ settledByFamily: [], collectedCents: 0 });
});

test("settled families exclude tips and put historical receipts without matching line allocations in unallocated", async () => {
  const receipt = await sale();
  await settle(receipt.id, receipt.totalCents);
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  }).format(new Date());
  const path = `/admin/accounting/sales?from=${date}&to=${date}`;
  expect(await (await call(owner, path)).json()).toMatchObject({
    soldCents: 9500,
    tipsCents: 500,
    settledByFamily: [{ family: "service", amountCents: 9000, taxCents: 0 }],
  });
  const { sql } = await import("drizzle-orm");
  await t.db.execute(
    sql`update checkout_line set discount_cents = 0 where checkout_id = ${receipt.id}`,
  );
  expect(await (await call(owner, path)).json()).toMatchObject({
    soldCents: 9500,
    settledByFamily: [{ family: "unallocated", amountCents: 9000, taxCents: 0 }],
  });
});

test("client sales use the current merged identity, professional and settlement period", async () => {
  const [target, alias, unrelated] = await t.db
    .insert(clientProfile)
    .values([
      { name: "Primary profile" },
      { name: "Historical profile" },
      { name: "Other profile" },
    ])
    .returning();
  if (!target || !alias || !unrelated) throw new Error("Missing client fixture");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires",
  });
  const from = formatter.format(new Date());
  async function customReceipt(clientId: string | undefined, amountCents: number) {
    const response = await call(owner, "/admin/commerce/checkouts", "POST", {
      clientId,
      staffId: staff.staffId,
      lines: [
        { kind: "custom", description: "Fixture sale", quantity: 1, unitAmountCents: amountCents },
      ],
      idempotencyKey: key(),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };
    return settle(id, amountCents);
  }
  const historicPayment = await customReceipt(alias.id, 5000);
  await customReceipt(target.id, 2500);
  await customReceipt(undefined, 4000);
  await customReceipt(unrelated.id, 2000);
  const refund = await call(
    owner,
    `/admin/commerce/payments/${historicPayment.id}/refunds`,
    "POST",
    { amountCents: 1000, reason: "Fixture refund", idempotencyKey: key() },
  );
  expect(refund.status).toBe(201);
  const pair = { sourceId: alias.id, targetId: target.id };
  const preview = await call(owner, "/admin/clients/merge/preview", "POST", pair);
  expect(preview.status).toBe(200);
  const { reviewHash } = (await preview.json()) as { reviewHash: string };
  const merged = await call(owner, "/admin/clients/merge", "POST", {
    ...pair,
    confirmedSamePerson: true,
    reviewHash,
    idempotencyKey: key(),
  });
  expect(merged.status).toBe(201);
  const to = formatter.format(new Date());
  const base = `/admin/accounting/sales?from=${from}&to=${to}`;
  const path = `${base}&clientId=${alias.id}`;
  const result = await call(owner, path);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  expect(await result.json()).toMatchObject({
    client: { id: target.id, name: target.name },
    collectedCents: 7500,
    refundedCents: 1000,
    netCollectedCents: 6500,
    settledByFamily: [{ family: "custom", amountCents: 7500, taxCents: 0 }],
    cashSessions: [],
  });
  expect(await (await call(owner, `${path}&staffId=${other.staffId}`)).json()).toMatchObject({
    collectedCents: 0,
    refundedCents: 0,
    settledByFamily: [],
  });
  expect((await call(staff, path)).status).toBe(403);
  expect((await call(owner, `${base}&clientId=${key()}`)).status).toBe(404);
  expect(await (await call(owner, base)).json()).toMatchObject({ collectedCents: 13500 });
});
test("upgrade backfills open receipt attribution and allocations without changing historical totals", async () => {
  const checkout = await sale();
  await t.db.execute(
    (await import("drizzle-orm"))
      .sql`update checkout set staff_id = null where id = ${checkout.id}`,
  );
  await t.db.execute(
    (await import("drizzle-orm"))
      .sql`update checkout_line set discount_cents = 0, tax_cents = 0 where checkout_id = ${checkout.id}`,
  );
  const upgrade = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0012_backfill_checkout_attribution.sql",
      import.meta.url,
    ),
  ).text();
  const { sql } = await import("drizzle-orm");
  await t.db.execute(sql.raw(upgrade));
  await policy();
  await settle(checkout.id, 9500);
  expect((await statement()).earnedCents).toBe(2250);
  const receipt = (await (
    await call(owner, `/admin/commerce/checkouts/${checkout.id}`)
  ).json()) as { totalCents: number; taxCents: number; staffId: string };
  expect(receipt).toMatchObject({ totalCents: 9500, taxCents: 0, staffId: staff.staffId });
});
test("concurrent payout records cannot both spend the same commission balance", async () => {
  await policy();
  const checkout = await sale({ discountCents: 0, tipCents: 0 });
  await settle(checkout.id, 10000);
  const path = `/admin/accounting/staff/${staff.staffId}/payouts`;
  const responses = await Promise.all(
    [1, 2].map((n) =>
      call(owner, path, "POST", {
        amountCents: 2000,
        reference: `External transfer ${n}`,
        idempotencyKey: key(),
      }),
    ),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(await statement()).toMatchObject({
    earnedCents: 2500,
    paidCents: 2000,
    outstandingCents: 500,
  });
});
test("unconfigured sales do not invent earnings, and a staff seller cannot impersonate another", async () => {
  const checkout = await sale();
  await settle(checkout.id, 9500);
  expect((await statement()).earnedCents).toBe(0);
  const forged = await call(staff, "/admin/commerce/checkouts", "POST", {
    staffId: other.staffId,
    lines: [
      { kind: "custom", description: "Other professional", quantity: 1, unitAmountCents: 1000 },
    ],
    idempotencyKey: key(),
  });
  expect(forged.status).toBe(403);
  expect((await call(owner, "/admin/accounting/sales?from=2026-03-10&to=2026-03-01")).status).toBe(
    400,
  );
});
