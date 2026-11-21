import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  calendarResponseSchema,
  checkoutListSchema,
  checkoutSchema,
  importedSettlementResponseSchema,
  syncPullResponseSchema,
  unpaidAppointmentsSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  auditLog,
  checkoutPayment,
  checkout as checkoutTable,
  clientProfile,
  salonSettings,
  service,
  serviceAddon,
  staffProfile,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { redsysSignature } from "../../payments/redsys";

const bankSecret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7"; // Official public test fixture.
let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let staff: Actor;
let client: Actor;
let other: Actor;
let appointmentId: string;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const checkout = async (who = owner, extra: Record<string, unknown> = {}) => {
  const res = await call(
    who,
    who.clientId !== null ? "/me/checkouts" : "/admin/commerce/checkouts",
    "POST",
    { appointmentId, idempotencyKey: crypto.randomUUID(), ...extra },
  );
  expect(res.status, await res.clone().text()).toBe(201);
  return checkoutSchema.parse(await res.json());
};
const pay = (
  id: string,
  method: string,
  amountCents: number,
  idempotencyKey = crypto.randomUUID(),
  who = owner,
) =>
  call(
    who,
    `${who.clientId !== null ? "/me" : "/admin/commerce"}/checkouts/${id}/payments`,
    "POST",
    { method, amountCents, idempotencyKey },
  );
const notify = (order: string, extra: Record<string, string> = {}, tamper = false) => {
  const encoded = Buffer.from(
    JSON.stringify({
      Ds_Order: order,
      Ds_Amount: "10000",
      Ds_Currency: "978",
      Ds_MerchantCode: "999008881",
      Ds_Terminal: "1",
      Ds_Response: "0000",
      Ds_TransactionType: "0",
      ...extra,
    }),
  ).toString("base64url");
  return t.app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Ds_MerchantParameters: encoded,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: tamper ? "A".repeat(86) : redsysSignature(bankSecret, order, encoded),
    }),
  });
};
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "commerce",
    env: {
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: bankSecret,
      REDSYS_ENVIRONMENT: "test",
      REDSYS_BIZUM_ENABLED: "true",
    },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff, client, other] = await Promise.all([
    actor(t, "owner", "owner@commerce.test"),
    actor(t, "staff", "staff@commerce.test", { staffProfileId: f.anaId }),
    actor(t, "client", "client@commerce.test"),
    actor(t, "client", "other@commerce.test"),
  ]);
  const principal = client;
  if (!principal.clientId) throw new Error("Client profile missing");
  const [row] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: principal.clientId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    })
    .returning();
  if (!row) throw new Error("Appointment insert failed");
  appointmentId = row.id;
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

test("a Booksy invoice on an existing checkout freezes further collections without rewriting payments", async () => {
  const sale = await checkout();
  expect((await pay(sale.id, "external_card", 1000)).status).toBe(201);
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "source-line-invoice",
    invoiced: true,
  });
  const blocked = await pay(sale.id, "external_card", 9000);
  expect(blocked.status).toBe(409);
  const existing = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(existing.paidCents).toBe(1000);
  expect(
    (
      await call(
        owner,
        `/admin/commerce/appointments/${appointmentId}/imported-settlement`,
        "PUT",
        {
          appointmentVersion: 1,
          amountCents: 10000,
          reference: "Original external receipt",
        },
      )
    ).status,
  ).toBe(409);
  const unpaid = await call(
    owner,
    "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(await unpaid.json()).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["invoiced_in_booksy"] }],
  });
});

test("a Booksy charge indicator prevents a duplicate appointment checkout", async () => {
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "source-line-paid",
    paid: true,
    invoiced: true,
    internalNote: "Private billing note",
  });
  const result = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(result.status).toBe(409);
  const review = await call(
    owner,
    "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  const body = await review.json();
  expect(body).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["paid_in_booksy", "invoiced_in_booksy"] }],
  });
  expect(JSON.stringify(body)).not.toContain("Private billing note");
});

test("an undocumented Booksy payment is held until the owner records evidence of no prior charge", async () => {
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "source-line-undocumented",
    paid: null,
  });
  const range = "from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  const currentRange = `${range}&booksyPaymentReview=1`;
  const calendarPath = "/appointments/calendar";
  const unpaidPath = "/admin/commerce/unpaid";
  const reviewPath = `/admin/commerce/appointments/${appointmentId}/imported-unpaid`;
  const input = { appointmentVersion: 1, reference: "Private external ledger review" };
  const checkoutPath = "/admin/commerce/checkouts";
  const attemptedSale = { appointmentId, idempotencyKey: crypto.randomUUID() };

  expect(await (await call(owner, `${calendarPath}?${currentRange}`)).json()).toMatchObject({
    appointments: [{ billingReviewReasons: ["unknown_booksy_payment"] }],
  });
  expect(await (await call(owner, `${unpaidPath}?${currentRange}`)).json()).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["unknown_booksy_payment"] }],
  });
  expect(await (await call(owner, `${unpaidPath}?${range}`)).json()).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["unknown_amount"] }],
  });
  const pull = async (query: string) =>
    syncPullResponseSchema.parse(await (await call(owner, `/sync/pull?${query}`)).json());
  const synced = (await pull("since=0&booksyPaymentReview=1")).changes.find(
    (c) => c.id === appointmentId,
  );
  if (!synced) throw new Error("Missing imported appointment in the replica");
  expect(synced.data).toMatchObject({ billingReviewReasons: ["unknown_booksy_payment"] });
  expect((await pull("since=0")).changes.find((c) => c.id === appointmentId)?.data).toMatchObject({
    billingReviewReasons: ["unknown_amount"],
  });
  expect((await call(owner, checkoutPath, "POST", attemptedSale)).status).toBe(409);
  expect((await call(staff, reviewPath, "PUT", input)).status).toBe(403);
  expect((await call(owner, reviewPath, "PUT", { ...input, appointmentVersion: 2 })).status).toBe(
    409,
  );
  const responses = await Promise.all([
    call(owner, reviewPath, "PUT", input),
    call(owner, reviewPath, "PUT", input),
  ]);
  for (const response of responses) {
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ appointmentVersion: 2 });
  }
  expect(
    (await call(owner, reviewPath, "PUT", { ...input, reference: "Different records" })).status,
  ).toBe(409);
  const updated = await pull(`since=${synced.seq}&booksyPaymentReview=1`);
  const updatedBooking = updated.changes.find((c) => c.id === appointmentId);
  expect(updatedBooking?.data).toMatchObject({
    version: 2,
    importedFromBooksy: true,
    booksyUnpaidConfirmed: true,
  });
  expect(updatedBooking?.data).not.toHaveProperty("billingReviewReasons");
  expect(JSON.stringify(updated)).not.toContain(input.reference);
  expect(await (await call(owner, `${unpaidPath}?${currentRange}`)).json()).toMatchObject({
    appointments: [{ id: appointmentId }],
  });
  expect(await t.db.select().from(appointmentContext)).toMatchObject([{ paid: null }]);
  expect(await t.db.select().from(checkoutTable)).toHaveLength(0);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);

  await t.db
    .update(appointmentContext)
    .set({ internalNote: "Changed note", version: 2 })
    .where(eq(appointmentContext.appointmentId, appointmentId));
  const updatedCalendar = calendarResponseSchema.parse(
    await (await call(owner, `${calendarPath}?${currentRange}`)).json(),
  );
  expect(updatedCalendar.appointments[0]).toMatchObject({ importedFromBooksy: true });
  expect(updatedCalendar.appointments[0]).not.toHaveProperty("billingReviewReasons");
  await t.db
    .update(appointmentContext)
    .set({ paid: true, version: 3 })
    .where(eq(appointmentContext.appointmentId, appointmentId));
  expect((await call(owner, checkoutPath, "POST", attemptedSale)).status).toBe(409);
  expect((await call(owner, reviewPath, "PUT", { ...input, appointmentVersion: 2 })).status).toBe(
    409,
  );
  await t.db
    .update(appointmentContext)
    .set({ paid: null, version: 4 })
    .where(eq(appointmentContext.appointmentId, appointmentId));
  expect((await call(owner, checkoutPath, "POST", attemptedSale)).status).toBe(409);
});

test("the owner can record a verified full payment when the Booksy marker is missing", async () => {
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "source-line-full-evidence",
    paid: false,
    sourcePaymentUnverified: true,
  });
  const path = `/admin/commerce/appointments/${appointmentId}/imported-settlement`;
  const unpaid = `/admin/commerce/appointments/${appointmentId}/imported-unpaid`;
  const before = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(before.status).toBe(409);
  expect(
    (
      await call(owner, unpaid, "PUT", {
        appointmentVersion: 1,
        reference: "Prior inspection of the source records",
      })
    ).status,
  ).toBe(200);
  const input = { appointmentVersion: 2, amountCents: 10000, reference: "Full external receipt" };
  expect((await call(owner, path, "PUT", { ...input, amountCents: 0 })).status).toBe(400);
  const recorded = await call(owner, path, "PUT", input);
  expect(recorded.status, await recorded.clone().text()).toBe(200);
  expect(await recorded.json()).toMatchObject({
    appointmentVersion: 3,
    settlement: { amountCents: 10000 },
  });
  expect(await t.db.select().from(checkoutTable)).toHaveLength(0);
});

test("the owner can reconcile a full Booksy settlement without a receipt or a second charge", async () => {
  const path = `/admin/commerce/appointments/${appointmentId}/imported-settlement`;
  const input = {
    appointmentVersion: 1,
    amountCents: 10000,
    reference: "Private original receipt",
  };
  expect((await call(owner, path, "PUT", input)).status).toBe(409);
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "settlement-test",
    invoiced: true,
    paid: null,
  });
  expect((await call(staff, path, "PUT", input)).status).toBe(403);
  expect((await call(owner, path, "PUT", { ...input, amountCents: 2000 })).status).toBe(400);
  expect((await call(owner, path, "PUT", { ...input, appointmentVersion: 2 })).status).toBe(409);
  const responses = await Promise.all([
    call(owner, path, "PUT", input),
    call(owner, path, "PUT", input),
  ]);
  const [first, retry] = await Promise.all(
    responses.map(async (res) => {
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      return importedSettlementResponseSchema.parse(await res.json());
    }),
  );
  expect(first).toMatchObject({
    settlement: { amountCents: 10000, reference: input.reference },
  });
  expect(retry).toEqual(first);
  expect(
    (await call(owner, path, "PUT", { ...input, reference: "Different evidence" })).status,
  ).toBe(409);
  expect((await call(staff, path)).status).toBe(403);
  expect(await (await call(owner, path)).json()).toEqual(first);

  const range = "?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  const calendar = await (await call(owner, `/appointments/calendar${range}`)).text();
  expect(JSON.parse(calendar)).toMatchObject({
    appointments: [{ id: appointmentId, version: 2, externallySettled: true }],
  });
  expect(calendar).not.toContain(input.reference);
  expect(await (await call(owner, `/admin/commerce/unpaid${range}`)).json()).toEqual({
    appointments: [],
  });
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(checkoutTable)).toHaveLength(0);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);
  expect(await t.db.select().from(appointmentContext)).toMatchObject([
    { invoiced: true, paid: null },
  ]);
  await t.db.delete(appointmentContext).where(eq(appointmentContext.appointmentId, appointmentId));
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const audit = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "commerce.imported_settlement_recorded"));
  expect(audit).toHaveLength(1);
});

test("a verified Booksy part-payment leaves only the outstanding balance collectible", async () => {
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "synthetic-partial-payment",
    paid: true,
    invoiced: true,
  });
  const readSync = async (since: number) =>
    syncPullResponseSchema.parse(
      await (await call(owner, `/sync/pull?since=${since}&limit=500`)).json(),
    );
  const initial = await readSync(0);
  expect(initial.changes.find(({ id }) => id === appointmentId)?.data).toMatchObject({
    billingReviewReasons: ["paid_in_booksy", "invoiced_in_booksy"],
    serviceBadges: [{ invoiced: true, paid: true, billingSource: "booksy" }],
  });
  const path = `/admin/commerce/appointments/${appointmentId}/imported-partial-payment`;
  const input = {
    appointmentVersion: 1,
    amountCents: 3500,
    reference: "Private installment receipt",
  };
  expect((await call(staff, path)).status).toBe(403);
  const preview = await call(owner, path);
  expect(preview.headers.get("cache-control")).toBe("private, no-store");
  expect(await preview.json()).toEqual({ appointmentVersion: 1, originalTotalCents: 10000 });
  expect((await call(staff, path, "PUT", input)).status).toBe(403);
  expect((await call(owner, path, "PUT", { ...input, amountCents: 10000 })).status).toBe(400);
  const [confirmation, retry] = await Promise.all([
    call(owner, path, "PUT", input),
    call(owner, path, "PUT", input),
  ]);
  expect(confirmation.status, await confirmation.clone().text()).toBe(200);
  expect(retry.status).toBe(200);
  const externalBalance = { paidInBooksyCents: 3500, dueInCitameCents: 6500 };
  expect(await confirmation.json()).toEqual({ appointmentVersion: 2, externalBalance });
  expect(await (await call(owner, path)).json()).toEqual({
    appointmentVersion: 2,
    externalBalance,
  });
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);
  expect(await t.db.select().from(checkoutTable)).toHaveLength(0);
  expect((await call(owner, path, "PUT", { ...input, amountCents: 4000 })).status).toBe(409);
  const range = "?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  const unpaid = await (await call(owner, `/admin/commerce/unpaid${range}`)).text();
  expect(JSON.parse(unpaid)).toMatchObject({
    appointments: [{ id: appointmentId, externalBalance }],
  });
  expect(unpaid).not.toContain(input.reference);
  const calendar = async () =>
    calendarResponseSchema
      .parse(await (await call(owner, `/appointments/calendar${range}`)).json())
      .appointments.find(({ id }) => id === appointmentId);
  const expectedPartial = {
    externalBalance,
    serviceBadges: [{ invoiced: true, paid: false, billingSource: "booksy" }],
  };
  const webPartial = await calendar();
  expect(webPartial).toMatchObject(expectedPartial);
  expect(webPartial?.billingReviewReasons).toBeUndefined();
  const review = await readSync(initial.nextCursor);
  const synced = review.changes.find(({ id }) => id === appointmentId)?.data;
  expect(synced).toMatchObject(expectedPartial);
  expect(synced).not.toHaveProperty("billingReviewReasons");
  expect(JSON.stringify(review)).not.toContain(input.reference);
  const annotations = await call(owner, `/appointments/${appointmentId}/context`);
  expect(await annotations.json()).toMatchObject({ rows: [{ paid: true, invoiced: true }] });

  const backfill = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0076_sync_calendar_annotation_badges.sql",
      import.meta.url,
    ),
  ).text();
  await t.db.transaction(async (tx) => {
    for (const statement of backfill.split("--> statement-breakpoint")) {
      await tx.execute(sql.raw(statement.trim()));
    }
  });
  const replayed = await readSync(review.nextCursor);
  expect(replayed.changes.find(({ id }) => id === appointmentId)?.data).toEqual(synced);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);
  const discounted = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    discountCents: 100,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(discounted.status).toBe(400);
  const sale = await checkout();
  expect(sale).toMatchObject({
    externalBalance,
    lines: [{ kind: "external_balance", unitAmountCents: 6500 }],
    totalCents: 6500,
    balanceCents: 6500,
    paidCents: 0,
  });
  expect((await pay(sale.id, "external_card", 10000)).status).toBe(409);
  expect((await pay(sale.id, "external_card", 6500)).status).toBe(201);
  const final = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(final).toMatchObject({ status: "paid", paidCents: 6500, balanceCents: 0 });
  const recorded = {
    externalBalance,
    serviceBadges: [{ invoiced: true, paid: true, billingSource: "citame" }],
  };
  expect(await calendar()).toMatchObject(recorded);
  const collected = (await readSync(replayed.nextCursor)).changes.find(
    ({ id }) => id === appointmentId,
  );
  expect(collected?.data).toMatchObject(recorded);
  expect(collected?.data).not.toHaveProperty("billingReviewReasons");
  expect(await t.db.select().from(checkoutPayment)).toMatchObject([{ amountCents: 6500 }]);
  expect(await (await call(owner, `/admin/commerce/unpaid${range}`)).json()).toEqual({
    appointments: [],
  });
});

test("a native imported service with no quoted amount is never checked out as free", async () => {
  await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0 })
    .where(eq(appointmentService.appointmentId, appointmentId));
  const view = await call(
    owner,
    "/appointments/calendar?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(await view.json()).toMatchObject({
    appointments: [
      {
        services: [{ sourceUnpriced: true }],
        billingReviewReasons: ["unknown_amount"],
      },
    ],
  });
  const blocked = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(blocked.status).toBe(409);
  const review = await call(
    owner,
    "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(await review.json()).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["unknown_amount"] }],
  });
});

test("an owner can verify an unknown price once without changing the original or creating a sale", async () => {
  const [line] = await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0 })
    .where(eq(appointmentService.appointmentId, appointmentId))
    .returning();
  const path = `/admin/commerce/appointments/${appointmentId}/imported-price`;
  const input = {
    appointmentVersion: 1,
    reference: "Reviewed quote fixture",
    lines: [{ id: line!.id, amountCents: 3650 }],
  };
  expect((await call(staff, path, "PUT", input)).status).toBe(403);
  expect((await call(staff, path)).status).toBe(403);
  const preview = await call(owner, path);
  expect(preview.headers.get("cache-control")).toBe("private, no-store");
  expect(await preview.json()).toMatchObject({ appointmentVersion: 1, lines: [{ id: line!.id }] });
  expect((await call(owner, path, "PUT", { ...input, appointmentVersion: 2 })).status).toBe(409);
  expect(
    (
      await call(owner, path, "PUT", {
        ...input,
        lines: [{ id: crypto.randomUUID(), amountCents: 3650 }],
      })
    ).status,
  ).toBe(400);
  const [first, retry] = await Promise.all([
    call(owner, path, "PUT", input),
    call(owner, path, "PUT", input),
  ]);
  expect(first.status, await first.clone().text()).toBe(200);
  expect(retry.status, await retry.clone().text()).toBe(200);
  expect((await call(owner, path)).status).toBe(409);
  const changed = await call(owner, path, "PUT", {
    ...input,
    lines: [{ id: line!.id, amountCents: 5500 }],
  });
  expect(changed.status).toBe(409);
  expect(await t.db.select().from(appointmentService)).toMatchObject([
    { id: line!.id, priceCents: 0, sourceUnpriced: true, reviewedPriceCents: 3650 },
  ]);
  const audits = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "commerce.imported_price_reviewed"));
  expect(audits).toHaveLength(1);
  expect(audits[0]?.metadata.reference).toBe(input.reference);
  expect(await t.db.select().from(checkoutTable)).toHaveLength(0);
  const due = await call(
    owner,
    "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  expect(await due.json()).toMatchObject({
    appointments: [{ id: appointmentId, version: 2, services: [{ priceCents: 3650 }] }],
  });
  expect(await checkout()).toMatchObject({ subtotalCents: 3650, paidCents: 0, status: "open" });
});

test("a verified price keeps the Booksy hold until the owner reconciles the partial payment", async () => {
  const existing = await checkout();
  const [line] = await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0 })
    .where(eq(appointmentService.appointmentId, appointmentId))
    .returning();
  const path = `/admin/commerce/appointments/${appointmentId}/imported-price`;
  const input = {
    appointmentVersion: 1,
    reference: "Reviewed quote fixture",
    lines: [{ id: line!.id, amountCents: 3650 }],
  };
  expect((await call(owner, path)).status).toBe(409);
  expect((await call(owner, path, "PUT", input)).status).toBe(409);
  expect((await call(owner, `/admin/commerce/checkouts/${existing.id}/void`, "POST")).status).toBe(
    200,
  );
  await t.db.insert(appointmentContext).values({
    appointmentId,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "synthetic-invoice",
    invoiced: true,
  });
  const partial = `/admin/commerce/appointments/${appointmentId}/imported-partial-payment`;
  expect((await call(owner, partial)).status).toBe(409);
  expect((await call(staff, path)).status).toBe(403);
  expect((await call(owner, path)).status).toBe(200);
  expect((await call(owner, path, "PUT", input)).status).toBe(200);
  expect(await t.db.select().from(appointmentService)).toMatchObject([
    { priceCents: 0, sourceUnpriced: true, reviewedPriceCents: 3650 },
  ]);
  expect(await t.db.select().from(appointmentContext)).toMatchObject([{ invoiced: true }]);
  const range = "?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  expect(await (await call(owner, `/admin/commerce/unpaid${range}`)).json()).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, reasons: ["invoiced_in_booksy"] }],
  });
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await (await call(owner, partial)).json()).toEqual({
    appointmentVersion: 2,
    originalTotalCents: 3650,
  });
  const payment = { appointmentVersion: 2, amountCents: 1000, reference: "Deposit receipt" };
  expect((await call(owner, partial, "PUT", { ...payment, appointmentVersion: 1 })).status).toBe(
    409,
  );
  expect((await call(owner, partial, "PUT", payment)).status).toBe(200);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);
  expect(await checkout()).toMatchObject({
    lines: [{ kind: "external_balance", unitAmountCents: 2650 }],
    totalCents: 2650,
    paidCents: 0,
    balanceCents: 2650,
  });
});

test("builds totals from immutable appointment snapshots, not a browser total", async () => {
  const result = await checkout(owner, { discountCents: 1000, tipCents: 500 });
  expect(result).toMatchObject({
    status: "open",
    subtotalCents: 10000,
    discountCents: 1000,
    tipCents: 500,
    totalCents: 9500,
    balanceCents: 9500,
    paidCents: 0,
  });
  expect(result.lines[0]).toMatchObject({ description: "Haircut", unitAmountCents: 10000 });
  expect(
    (
      await call(client, "/me/checkouts", "POST", {
        appointmentId,
        discountCents: 9999,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
});
test("clients see and pay only their own orders and cannot record manual cash", async () => {
  const result = await checkout(client);
  expect((await call(other, `/me/checkouts/${result.id}`)).status).toBe(404);
  expect((await pay(result.id, "redsys_card", 10000, crypto.randomUUID(), other)).status).toBe(404);
  expect((await pay(result.id, "cash", 10000, crypto.randomUUID(), client)).status).toBe(403);
  expect((await call(null, "/admin/commerce/checkouts")).status).toBe(401);
  expect((await call(client, "/admin/commerce/checkouts")).status).toBe(403);
});
test("a hosted checkout stays unpaid until a matching signed bank notification", async () => {
  const sale = await checkout(client);
  const response = await pay(sale.id, "redsys_card", 10000, crypto.randomUUID(), client);
  expect(response.status).toBe(201);
  const started = (await response.json()) as {
    payment: { order: string; status: string };
    form: { action: string };
  };
  expect(started.form.action).toContain("sis-t.redsys.es");
  expect(started.payment.status).toBe("pending");
  expect(
    checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json()).paidCents,
  ).toBe(0);
  expect((await notify(started.payment.order, {}, true)).status).toBe(400);
  expect((await notify(started.payment.order, { Ds_Amount: "1" })).status).toBe(400);
  expect((await notify(started.payment.order)).status).toBe(200);
  expect((await notify(started.payment.order)).status).toBe(200);
  const paid = checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json());
  expect(paid).toMatchObject({ status: "paid", paidCents: 10000, balanceCents: 0 });
  expect(paid.payments).toHaveLength(1);
  expect((await notify(started.payment.order, { Ds_Response: "0190" })).status).toBe(200);
  expect(
    checkoutSchema.parse(await (await call(client, `/me/checkouts/${sale.id}`)).json()).status,
  ).toBe("paid");
});
test("a bank decline releases the balance and pending attempts prevent a second collection", async () => {
  const sale = await checkout();
  const started = (await (await pay(sale.id, "redsys_bizum", 10000)).json()) as {
    payment: { order: string };
  };
  expect((await pay(sale.id, "redsys_card", 10000)).status).toBe(409);
  await notify(started.payment.order, { Ds_Response: "0190" });
  const current = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(current).toMatchObject({ status: "open", paidCents: 0 });
  expect(current.payments[0]?.status).toBe("failed");
  expect((await pay(sale.id, "redsys_card", 10000)).status).toBe(201);
});
test("checkout and payment idempotency reject changed payloads and concurrent overspending", async () => {
  const key = crypto.randomUUID();
  const a = await checkout(owner, { idempotencyKey: key });
  const replay = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId,
    idempotencyKey: key,
  });
  expect(checkoutSchema.parse(await replay.json()).id).toBe(a.id);
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: key,
        tipCents: 100,
      })
    ).status,
  ).toBe(409);
  const paymentKey = crypto.randomUUID();
  const first = await pay(a.id, "redsys_card", 10000, paymentKey);
  const second = await pay(a.id, "redsys_card", 10000, paymentKey);
  expect(((await first.json()) as { payment: { id: string } }).payment.id).toBe(
    ((await second.json()) as { payment: { id: string } }).payment.id,
  );
  expect((await pay(a.id, "redsys_card", 1000, paymentKey)).status).toBe(409);
});
test("cash sessions reconcile partial payments, movements, tips and refunds exactly once", async () => {
  expect(
    (await call(client, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 })).status,
  ).toBe(403);
  const opened = await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 });
  expect(opened.status).toBe(201);
  const session = (await opened.json()) as { id: string };
  expect(
    (await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })).status,
  ).toBe(409);
  const sale = await checkout(owner, { tipCents: 500 });
  const key = crypto.randomUUID();
  const cash = await pay(sale.id, "cash", 5000, key, staff);
  expect(cash.status).toBe(201);
  await pay(sale.id, "cash", 5000, key, staff);
  expect((await pay(sale.id, "external_card", 5500, crypto.randomUUID(), staff)).status).toBe(201);
  const paid = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(paid).toMatchObject({ paidCents: 10500, balanceCents: 0, status: "paid" });
  const paymentId = ((await cash.json()) as { payment: { id: string } }).payment.id;
  const refundKey = crypto.randomUUID();
  const body = { amountCents: 1000, reason: "Partial refund", idempotencyKey: refundKey };
  expect(
    (await call(staff, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body)).status,
  ).toBe(403);
  expect(
    (await call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body)).status,
  ).toBe(201);
  await call(owner, `/admin/commerce/payments/${paymentId}/refunds`, "POST", body);
  expect(
    checkoutSchema.parse(await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json())
      .refundedCents,
  ).toBe(1000);
  const closed = await call(owner, `/admin/commerce/cash-sessions/${session.id}/close`, "POST", {
    countedCents: 8900,
  });
  expect(closed.status).toBe(200);
  expect(await closed.json()).toMatchObject({
    expectedCents: 9000,
    countedCents: 8900,
    differenceCents: -100,
  });
});

test("reviewed cash commands replay against their original register and reject stale counts", async () => {
  const base = "/admin/commerce/cash-sessions";
  const open = { sessionId: crypto.randomUUID(), openingCents: 5000 };
  const write = (path: string, input: object) => call(owner, path, "POST", input);
  expect(await (await write(base, open)).json()).toMatchObject({ id: open.sessionId });
  expect((await write(base, { ...open, openingCents: 50 })).status).toBe(409);
  const deposit = {
    sessionId: open.sessionId,
    kind: "deposit",
    amountCents: 1000,
    reason: "Verified receipt",
    idempotencyKey: crypto.randomUUID(),
  };
  const adjust = (input: object) => write(`${base}/adjust`, input);
  expect(await (await adjust(deposit)).json()).toMatchObject({ expectedCents: 6000 });
  const close = (reviewedExpectedCents: number) =>
    write(`${base}/${open.sessionId}/close`, { reviewedExpectedCents, countedCents: 5900 });
  expect((await close(5000)).status).toBe(409);
  expect(await (await close(6000)).json()).toMatchObject({ differenceCents: -100 });
  const next = { sessionId: crypto.randomUUID(), openingCents: 200 };
  expect((await write(base, next)).status).toBe(201);
  expect(await (await write(base, open)).json()).toMatchObject({
    id: open.sessionId,
    countedCents: 5900,
  });
  expect(await (await adjust(deposit)).json()).toMatchObject({
    id: open.sessionId,
    expectedCents: 6000,
    movements: [{ amountCents: 1000 }],
  });
  expect((await adjust({ ...deposit, idempotencyKey: crypto.randomUUID() })).status).toBe(409);
  expect(await (await call(owner, `${base}/current`)).json()).toMatchObject({
    session: { id: next.sessionId, expectedCents: 200, movements: [] },
  });
});

test("concurrent partial cash payments cannot exceed the order and cash counts cannot be rewritten", async () => {
  const opened = (await (
    await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })
  ).json()) as { id: string };
  const sale = await checkout();
  const results = await Promise.all([pay(sale.id, "cash", 7000), pay(sale.id, "cash", 7000)]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const view = checkoutSchema.parse(
    await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json(),
  );
  expect(view).toMatchObject({ paidCents: 7000, balanceCents: 3000 });
  expect(
    (
      await call(owner, `/admin/commerce/cash-sessions/${opened.id}/close`, "POST", {
        countedCents: 7000,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(owner, `/admin/commerce/cash-sessions/${opened.id}/close`, "POST", {
        countedCents: 0,
      })
    ).status,
  ).toBe(409);
  expect((await pay(sale.id, "cash", 3000)).status).toBe(409);
});
test("currency mismatches and cross-origin browser mutations cannot create a charge", async () => {
  await t.db.update(appointmentService).set({ currency: "ARS" });
  expect(
    (
      await call(owner, "/admin/commerce/checkouts", "POST", {
        appointmentId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400);
  const response = await t.app.request("/admin/commerce/checkouts", {
    method: "POST",
    headers: {
      cookie: owner.cookie,
      origin: "https://attacker.example",
      "content-type": "application/json",
    },
    body: JSON.stringify({ appointmentId, idempotencyKey: crypto.randomUUID() }),
  });
  expect(response.status).toBe(403);
});
test("financial mutations are audited and duplicate callbacks do not create duplicate audit entries", async () => {
  const sale = await checkout();
  const started = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { order: string };
  };
  await notify(started.payment.order);
  await notify(started.payment.order);
  const rows = await t.db.execute<{ action: string }>(
    sql`select action from audit_log where action like 'commerce.%' order by created_at`,
  );
  expect(rows.map((row) => row.action)).toEqual([
    "commerce.checkout_created",
    "commerce.payment_started",
    "commerce.payment_settled",
  ]);
});

test("a client can open an existing staff-priced receipt without overriding its discount", async () => {
  const sale = await checkout(owner, { discountCents: 1000 });
  const response = await call(client, "/me/checkouts", "POST", {
    appointmentId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  expect(checkoutSchema.parse(await response.json())).toMatchObject({
    id: sale.id,
    totalCents: 9000,
    discountCents: 1000,
  });
});
test("register withdrawals cannot create negative physical cash", async () => {
  await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 5000 });
  expect(
    (
      await call(owner, "/admin/commerce/cash-sessions/adjust", "POST", {
        kind: "withdrawal",
        amountCents: 5001,
        reason: "Supplier payment",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});

test("oversized and repeated bank form fields are rejected as invalid notifications", async () => {
  for (const body of [`a=${"a".repeat(16001)}`, "Ds_Signature=x&Ds_Signature=y"]) {
    const response = await t.app.request("/payments/redsys/notify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(response.status).toBe(400);
  }
});

test("late successful bank notifications remain in the ledger as excess funds requiring a refund", async () => {
  const sale = await checkout();
  const old = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { id: string; order: string };
  };
  await notify(old.payment.order, { Ds_Response: "0190" });
  const current = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { order: string };
  };
  await notify(current.payment.order);
  await notify(old.payment.order);
  const view = (await (await call(owner, `/admin/commerce/checkouts/${sale.id}`)).json()) as {
    paidCents: number;
    overpaidCents: number;
  };
  expect(view).toMatchObject({ paidCents: 20000, overpaidCents: 10000 });
  const refund = await call(owner, `/admin/commerce/payments/${old.payment.id}/refunds`, "POST", {
    amountCents: 10000,
    reason: "Return duplicate bank capture",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(refund.status).toBe(201);
});
test("an abandoned bank attempt can be reconciled by an owner after checking the bank portal", async () => {
  const sale = await checkout();
  const payment = (await (await pay(sale.id, "redsys_card", 10000)).json()) as {
    payment: { id: string };
  };
  const body = { outcome: "failed", reference: "Bank portal confirms no charge REF-902" };
  const path = `/admin/commerce/payments/${payment.payment.id}/reconcile`;
  expect((await call(staff, path, "POST", body)).status).toBe(403);
  expect((await call(owner, path, "POST", body)).status).toBe(409);
  await t.db.execute(
    sql`update checkout_payment set updated_at = now() - interval '2 minutes' where id = ${payment.payment.id}`,
  );
  expect((await call(owner, path, "POST", body)).status).toBe(200);
  expect((await pay(sale.id, "external_card", 10000)).status).toBe(201);
});

test("a cash refund cannot spend cash absent from a newly opened drawer", async () => {
  const firstSession = (await (
    await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })
  ).json()) as { id: string };
  const sale = await checkout();
  const paid = (await (await pay(sale.id, "cash", 10000)).json()) as { payment: { id: string } };
  await call(owner, `/admin/commerce/cash-sessions/${firstSession.id}/close`, "POST", {
    countedCents: 10000,
  });
  await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 });
  expect(
    (
      await call(owner, `/admin/commerce/payments/${paid.payment.id}/refunds`, "POST", {
        amountCents: 1000,
        reason: "Customer return",
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});
test("discount tax allocation stays within each line and uses exact integer ratios", async () => {
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [
      {
        kind: "custom",
        description: "Bulk retail",
        quantity: 3,
        unitAmountCents: 666666665,
        taxBasisPoints: 10000,
      },
      {
        kind: "custom",
        description: "Small item",
        quantity: 1,
        unitAmountCents: 2,
        taxBasisPoints: 10000,
      },
    ],
    discountCents: 999999999,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const receipt = await response.json();
  expect(checkoutSchema.safeParse(receipt).success).toBe(true);
  expect(receipt).toMatchObject({ totalCents: 999999998, taxCents: 499999999 });
  const pennies = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [1, 2, 3].map((i) => ({
      kind: "custom",
      description: `Item ${i}`,
      quantity: 1,
      unitAmountCents: 1,
      taxBasisPoints: 10000,
    })),
    discountCents: 2,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(pennies.status).toBe(201);
  expect(await pennies.json()).toMatchObject({ totalCents: 1, taxCents: 1 });
});

test("walk-in catalog services use canonical prices and do not create appointments", async () => {
  await t.db
    .update(service)
    .set({ currency: "EUR", priceCents: 2500 })
    .where(eq(service.id, f.haircutId));
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "service", serviceId: f.haircutId, quantity: 2 }],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const order = checkoutSchema.parse(await response.json());
  expect(order.appointmentId).toBeNull();
  expect(order.totalCents).toBe(5000);
  expect(order.lines[0]).toMatchObject({
    kind: "service",
    serviceId: f.haircutId,
    description: "Haircut",
    quantity: 2,
    unitAmountCents: 2500,
  });
  const tampered = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "service", serviceId: f.haircutId, quantity: 1, unitAmountCents: 1 }],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(tampered.status).toBe(400);
});

test("walk-in catalog services reject inactive, foreign-currency and incompatible extras", async () => {
  const request = (serviceId: string) =>
    call(owner, "/admin/commerce/checkouts", "POST", {
      lines: [{ kind: "service", serviceId, quantity: 1 }],
      idempotencyKey: crypto.randomUUID(),
    });
  expect((await request(f.haircutId)).status).toBe(400);
  await t.db
    .update(service)
    .set({ currency: "EUR", active: false })
    .where(eq(service.id, f.haircutId));
  expect((await request(f.haircutId)).status).toBe(400);
  await t.db.update(service).set({ active: true }).where(eq(service.id, f.haircutId));
  const [extra] = await t.db
    .insert(service)
    .values({
      name: "Extra",
      catalogKind: "addon",
      durationMinutes: 0,
      priceCents: 500,
      currency: "EUR",
    })
    .returning();
  if (!extra) throw Error("Missing extra");
  await t.db.insert(serviceAddon).values({ addonId: extra.id, serviceId: f.haircutId });
  expect((await request(extra.id)).status).toBe(400);
  const valid = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [
      { kind: "service", serviceId: f.haircutId, quantity: 1 },
      { kind: "service", serviceId: extra.id, quantity: 1 },
    ],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(valid.status, await valid.clone().text()).toBe(201);
  expect(
    (
      await call(client, "/me/checkouts", "POST", {
        lines: [{ kind: "service", serviceId: f.haircutId, quantity: 1 }],
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
});

test("transactions paginate, filter statuses and search receipt lines within the authorized scope", async () => {
  const first = await checkout(owner);
  await pay(first.id, "external_card", 10000);
  await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "custom", description: "Retail other", quantity: 1, unitAmountCents: 2000 }],
    idempotencyKey: crypto.randomUUID(),
  });
  const page = await call(owner, "/admin/commerce/checkouts?page=2&pageSize=1");
  const data = (await page.json()) as { total: number; checkouts: { id: string }[] };
  expect(data.total).toBe(2);
  expect(data.checkouts).toHaveLength(1);
  const filtered = (await (
    await call(owner, "/admin/commerce/checkouts?status=paid&method=external_card&search=Haircut")
  ).json()) as { total: number; checkouts: { id: string }[] };
  expect(filtered.total).toBe(1);
  expect(filtered.checkouts[0]?.id).toBe(first.id);
  expect(
    (
      await call(
        owner,
        "/admin/commerce/checkouts?from=2026-12-01T00:00:00Z&to=2026-11-01T00:00:00Z",
      )
    ).status,
  ).toBe(400);
});

test("transaction summaries cover the whole filtered local period with scoped payments and refunds", async () => {
  await t.db.update(salonSettings).set({ timezone: "Europe/Madrid" });
  expect(
    (await call(owner, "/admin/commerce/cash-sessions", "POST", { openingCents: 0 })).status,
  ).toBe(201);
  const first = await checkout();
  const charge = await pay(first.id, "cash", 6000);
  expect(charge.status).toBe(201);
  const { payment } = (await charge.json()) as { payment: { id: string } };
  expect((await pay(first.id, "external_card", 4000)).status).toBe(201);
  for (const amountCents of [1000, 500]) {
    const refund = await call(owner, `/admin/commerce/payments/${payment.id}/refunds`, "POST", {
      amountCents,
      reason: "Test refund",
      idempotencyKey: crypto.randomUUID(),
    });
    expect(refund.status).toBe(201);
  }

  const addReceipt = async (createdAt: Date) => {
    const response = await call(owner, "/admin/commerce/checkouts", "POST", {
      staffId: f.beaId,
      lines: [{ kind: "custom", description: "Haircut trial", quantity: 1, unitAmountCents: 2000 }],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(201);
    const receipt = checkoutSchema.parse(await response.json());
    expect((await pay(receipt.id, "external_card", 2000)).status).toBe(201);
    await t.db.update(checkoutTable).set({ createdAt }).where(eq(checkoutTable.id, receipt.id));
    return receipt.id;
  };
  const second = await addReceipt(new Date("2026-03-01T08:00:00Z"));
  await addReceipt(new Date("2026-02-28T22:59:59Z"));
  await t.db
    .update(checkoutTable)
    .set({ createdAt: new Date("2026-02-28T23:00:00Z") })
    .where(eq(checkoutTable.id, first.id));

  const path = "/admin/commerce/checkouts?pageSize=1&search=Haircut&method=external_card";
  const get = async (who: Actor, filters: string) => {
    const response = await call(who, `${path}${filters}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return checkoutListSchema.parse(await response.json());
  };
  const expected = [{ period: "2026-03-01", receipts: 2, paidCents: 12000, refundedCents: 1500 }];
  for (const [page, id] of [
    [1, second],
    [2, first.id],
  ] as const) {
    const daily = await get(owner, `&page=${page}&groupBy=day`);
    expect(daily.total).toBe(3);
    expect(daily.checkouts.map((receipt) => receipt.id)).toEqual([id]);
    expect(daily.groupTotals).toEqual({ timezone: "Europe/Madrid", rows: expected });
  }
  const march = await get(owner, "&groupBy=month&from=2026-02-28T23:00:00Z&status=paid");
  expect(march.total).toBe(1);
  expect(march.groupTotals?.rows).toEqual([
    { period: "2026-03-01", receipts: 1, paidCents: 2000, refundedCents: 0 },
  ]);
  const own = await get(staff, "&groupBy=day");
  expect(own.total).toBe(1);
  expect(own.groupTotals?.rows).toEqual([
    { period: "2026-03-01", receipts: 1, paidCents: 10000, refundedCents: 1500 },
  ]);
  expect((await get(owner, "&page=4&groupBy=month")).groupTotals?.rows).toEqual([]);
  expect((await get(owner, "")).groupTotals).toBeUndefined();
  expect((await call(client, `${path}&groupBy=month`)).status).toBe(403);
});

test("transaction summaries match visible local months when clocks roll back across midnight", async () => {
  await t.db.update(salonSettings).set({ timezone: "America/Goose_Bay" });
  const later = await checkout();
  const response = await call(owner, "/admin/commerce/checkouts", "POST", {
    lines: [{ kind: "custom", description: "Test receipt", quantity: 1, unitAmountCents: 100 }],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(201);
  const earlier = checkoutSchema.parse(await response.json());
  await t.db
    .update(checkoutTable)
    .set({ createdAt: new Date("2009-11-01T03:01:30Z") })
    .where(eq(checkoutTable.id, later.id));
  await t.db
    .update(checkoutTable)
    .set({ createdAt: new Date("2009-11-01T03:00:30Z") })
    .where(eq(checkoutTable.id, earlier.id));

  const path = "/admin/commerce/checkouts?groupBy=month";
  const list = async (query: string) => {
    const response = await call(owner, `${path}${query}`);
    expect(response.status).toBe(200);
    return checkoutListSchema.parse(await response.json());
  };
  const october = { period: "2009-10-01", receipts: 1, paidCents: 0, refundedCents: 0 };
  const totals = [{ period: "2009-11-01", receipts: 1, paidCents: 0, refundedCents: 0 }, october];
  expect((await list("")).groupTotals?.rows).toEqual(totals);
  expect((await list("&pageSize=1")).groupTotals?.rows).toEqual([october]);
});

test("unpaid appointments stay settled beyond the latest hundred sales and respect staff scope", async () => {
  const range = "/admin/commerce/unpaid?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  const otherAppointment = await t.db
    .insert(appointment)
    .values({
      staffId: f.beaId,
      clientId: client.clientId!,
      startsAt: new Date("2026-03-09T14:00:00Z"),
      endsAt: new Date("2026-03-09T15:00:00Z"),
    })
    .returning();
  expect((await call(client, range)).status).toBe(403);
  const response = await call(staff, range);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const before = (await response.json()) as { appointments: { id: string }[] };
  expect(before.appointments.map((row: { id: string }) => row.id)).toEqual([appointmentId]);
  const sale = await checkout();
  expect((await pay(sale.id, "external_card", 10000)).status).toBe(201);
  await t.db.execute(
    sql`update checkout set created_at=now()-interval '1 year' where id=${sale.id}`,
  );
  for (let index = 0; index < 101; index++) {
    const res = await call(owner, "/admin/commerce/checkouts", "POST", {
      lines: [
        { kind: "custom", description: `Later sale ${index}`, quantity: 1, unitAmountCents: 100 },
      ],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(res.status).toBe(201);
  }
  const after = (await (await call(owner, range)).json()) as { appointments: { id: string }[] };
  expect(after.appointments.map((row: { id: string }) => row.id)).toEqual([
    otherAppointment[0]!.id,
  ]);
  expect(await (await call(staff, range)).json()).toMatchObject({ appointments: [] });
});

test("cashiers can collect an inactive professional's historic appointments without exposing other sales to staff", async () => {
  const range = "?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  await t.db.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, f.anaId));

  const calendar = calendarResponseSchema.parse(
    await (await call(owner, `/appointments/calendar${range}`)).json(),
  );
  expect(calendar.staff.map((member) => member.id)).not.toContain(f.anaId);
  expect(calendar.appointments).toEqual([]);
  const archived = calendarResponseSchema.parse(
    await (await call(owner, `/appointments/calendar${range}&staffIds=${f.anaId}`)).json(),
  );
  expect(archived.appointments.map((item) => item.id)).toEqual([appointmentId]);

  const colleague = await actor(t, "staff", "colleague@commerce.test", { staffProfileId: f.beaId });
  const unpaid = `/admin/commerce/unpaid${range}`;
  const due = async (who: Actor) => {
    const response = await call(who, unpaid);
    expect(response.status).toBe(200);
    return unpaidAppointmentsSchema.parse(await response.json());
  };
  expect((await due(owner)).appointments.map((item) => item.id)).toEqual([appointmentId]);
  expect((await due(colleague)).appointments).toEqual([]);

  await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0 })
    .where(eq(appointmentService.appointmentId, appointmentId));
  expect(await due(owner)).toMatchObject({
    appointments: [],
    billingReview: [{ id: appointmentId, staffId: f.anaId, reasons: ["unknown_amount"] }],
  });
  expect((await due(colleague)).billingReview ?? []).toEqual([]);
  await t.db
    .update(appointmentService)
    .set({ reviewedPriceCents: 10000 })
    .where(eq(appointmentService.appointmentId, appointmentId));

  const sale = await checkout();
  expect(sale.staffId).toBe(f.anaId);
  expect((await pay(sale.id, "external_card", 10000)).status).toBe(201);
  expect((await due(owner)).appointments).toEqual([]);
});

test("the selected profile discount is calculated by the server and clients cannot opt into operator pricing", async () => {
  await t.db
    .update(clientProfile)
    .set({ contactDetails: { discountBasisPoints: 1250 } })
    .where(eq(clientProfile.id, client.clientId!));
  const receipt = await checkout(owner, { useClientDiscount: true });
  expect(receipt).toMatchObject({ subtotalCents: 10000, discountCents: 1250, totalCents: 8750 });
  expect(
    (
      await call(client, "/me/checkouts", "POST", {
        appointmentId,
        useClientDiscount: true,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
});
