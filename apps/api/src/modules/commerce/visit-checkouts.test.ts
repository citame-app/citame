import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  calendarResponseSchema,
  checkoutSchema,
  visitCheckoutSchema,
  visitPaymentSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  appointmentVisit,
  appointmentVisitPart,
  auditLog,
  cashMovement,
  checkout,
  checkoutPayment,
  retailProduct,
  user,
  visitPayment,
} from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { loadPrincipal } from "../../auth/principal";
import { collectVisitPayment } from "./visit-checkouts";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let staff: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "visit_checkouts" });
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff] = await Promise.all([
    actor(t, "owner", "owner@visit-checkouts.test"),
    actor(t, "staff", "staff@visit-checkouts.test", { staffProfileId: f.anaId }),
  ]);
});

async function group(source: "itinerary" | "import") {
  const groupId = crypto.randomUUID();
  const appointments = await t.db
    .insert(appointment)
    .values(
      [f.anaId, f.beaId].map((staffId, index) => ({
        clientId: f.clientId,
        staffId,
        visitGroupId: source === "import" ? groupId : undefined,
        startsAt: new Date(Date.UTC(2026, 2, 9, 12 + index)),
        endsAt: new Date(Date.UTC(2026, 2, 9, 13 + index)),
      })),
    )
    .returning();
  await t.db.insert(appointmentService).values(
    appointments.map(({ id }, index) => ({
      appointmentId: id,
      position: 0,
      serviceId: f.haircutId,
      name: "Haircut",
      durationMinutes: 60,
      bufferMinutes: 0,
      priceCents: index === 0 ? 1200 : 1900,
      currency: "EUR",
    })),
  );
  if (source === "itinerary") {
    await t.db.insert(appointmentVisit).values({
      id: groupId,
      clientId: f.clientId,
      createdBy: owner.userId,
      requestHash: "fixture",
    });
    await t.db.insert(appointmentVisitPart).values(
      appointments.map(({ id }, index) => ({
        visitId: groupId,
        appointmentId: id,
        position: index,
      })),
    );
  }
  const [first, second] = appointments;
  if (!first || !second) throw new Error("Visit appointment insert failed");
  return { groupId, first: first.id, second: second.id };
}

function prepare(id: string, who = owner) {
  return json(t.app, `/admin/commerce/visits/${id}/checkouts`, "POST", undefined, who.cookie);
}

test.each(["itinerary", "import"] as const)(
  "the calendar exposes the %s checkout only to an operator who can review the whole visit",
  async (source) => {
    const { first, groupId } = await group(source);
    const path = "/appointments/calendar?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
    const [full, own] = await Promise.all(
      [owner, staff].map(async ({ cookie }) =>
        calendarResponseSchema.parse(
          await (await json(t.app, path, "GET", undefined, cookie)).json(),
        ),
      ),
    );
    const item = full?.appointments.find(({ id }) => id === first);
    expect(item?.hasVisitCheckout).toBe(true);
    expect(item?.[source === "itinerary" ? "itineraryId" : "visitGroupId"]).toBe(groupId);
    expect(own?.appointments.find(({ id }) => id === first)?.hasVisitCheckout).toBeUndefined();
    const context = async ({ cookie }: Actor) =>
      (await (await json(t.app, `/appointments/${first}/context`, "GET", undefined, cookie)).json()) as {
        hasVisitCheckout?: boolean;
      };
    expect((await context(owner)).hasVisitCheckout).toBe(true);
    expect((await context(staff)).hasVisitCheckout).toBeUndefined();
  },
);

function collect(id: string, body: object, who = owner) {
  return json(t.app, `/admin/commerce/visits/${id}/payments`, "POST", body, who.cookie);
}

test("reassigning a calendar part does not expose a receipt owned by another professional", async () => {
  const { first, second } = await group("import");
  const sale = await json(
    t.app,
    "/admin/commerce/checkouts",
    "POST",
    {
      appointmentId: second,
      idempotencyKey: crypto.randomUUID(),
    },
    owner.cookie,
  );
  expect(sale.status).toBe(201);
  await t.db.update(appointment).set({ staffId: f.anaId }).where(eq(appointment.id, second));
  const path = "/appointments/calendar?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
  const visible = calendarResponseSchema.parse(
    await (await json(t.app, path, "GET", undefined, staff.cookie)).json(),
  );
  expect(visible.appointments).toHaveLength(2);
  expect(visible.appointments.every((entry) => !entry.hasVisitCheckout)).toBe(true);
  expect((await prepare(first, staff)).status).toBe(404);
});

async function paymentReview(id: string) {
  const result = await prepare(id);
  expect(result.status, await result.clone().text()).toBe(200);
  const body = visitCheckoutSchema.parse(await result.json());
  expect(body.paymentReview?.totalCents).toBe(3100);
  if (!body.paymentReview) throw new Error("Missing payment review");
  return body.paymentReview.token;
}

test("one cash payment records both receipt allocations and replays from either appointment", async () => {
  const { first, second } = await group("itinerary");
  const reviewToken = await paymentReview(first);
  const opened = await json(
    t.app,
    "/admin/commerce/cash-sessions",
    "POST",
    {
      openingCents: 0,
      sessionId: crypto.randomUUID(),
    },
    owner.cookie,
  );
  expect(opened.status, await opened.clone().text()).toBe(201);
  const input = { method: "cash", idempotencyKey: crypto.randomUUID(), reviewToken };
  const results = await Promise.all([collect(first, input), collect(second, input)]);
  for (const result of results) expect(result.status, await result.clone().text()).toBe(201);
  const [original, replay] = await Promise.all(
    results.map(async (result) => visitPaymentSchema.parse(await result.json())),
  );
  expect(original).toEqual(replay);
  expect(original?.totalCents).toBe(3100);
  const payments = await t.db.select().from(checkoutPayment);
  expect(payments.map((p) => p.amountCents).sort((a, b) => a - b)).toEqual([1200, 1900]);
  expect(await t.db.select().from(cashMovement)).toHaveLength(2);
  expect(
    await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "commerce.visit_payment_recorded")),
  ).toHaveLength(1);
  expect((await collect(first, { ...input, method: "external_card" })).status).toBe(409);
  expect((await t.db.select().from(checkoutPayment)).length).toBe(2);
});

test("a failure on the last cash allocation rolls back all payments and register movements", async () => {
  const { first } = await group("itinerary");
  const reviewToken = await paymentReview(first);
  const opened = await json(
    t.app,
    "/admin/commerce/cash-sessions",
    "POST",
    { openingCents: 999_998_000, sessionId: crypto.randomUUID() },
    owner.cookie,
  );
  expect(opened.status).toBe(201);
  const input = { method: "cash", idempotencyKey: crypto.randomUUID(), reviewToken };
  const result = await collect(first, input);
  expect(result.status).toBe(409);
  expect(await result.text()).toContain("cash limit");
  expect(await t.db.select().from(visitPayment)).toHaveLength(0);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(0);
  expect(await t.db.select().from(cashMovement)).toHaveLength(0);
});

test("separate simultaneous confirmations cannot record the same visit twice", async () => {
  const { first, second } = await group("import");
  const reviewToken = await paymentReview(first);
  const results = await Promise.all(
    [first, second].map((id) =>
      collect(id, { method: "external_card", idempotencyKey: crypto.randomUUID(), reviewToken }),
    ),
  );
  expect(results.map(({ status }) => status).sort()).toEqual([201, 409]);
  expect(await t.db.select().from(visitPayment)).toHaveLength(1);
  expect(await t.db.select().from(checkoutPayment)).toHaveLength(2);
});

test("an operator whose role changed after the request began cannot record a visit payment", async () => {
  const { first } = await group("itinerary");
  const reviewToken = await paymentReview(first);
  const prior = await loadPrincipal(t.db, owner.userId);
  if (!prior) throw new Error("Missing operator");
  await t.db.update(user).set({ role: "client" }).where(eq(user.id, owner.userId));
  const result = collectVisitPayment(
    t.db,
    first,
    { method: "external_card", reviewToken, idempotencyKey: crypto.randomUUID() },
    prior,
    { now: () => new Date(), generation: t.config.syncReplicaGeneration },
  );
  await expect(result).rejects.toMatchObject({ code: "forbidden" });
  expect(await t.db.select().from(visitPayment)).toHaveLength(0);
});

test("settling a visit with retail items can run alongside a counter receipt for the same customer", async () => {
  const { first, second } = await group("itinerary");
  const [product] = await t.db
    .insert(retailProduct)
    .values({
      sku: "VISIT-TEST",
      name: "Test product",
      priceCents: 500,
      stockOnHand: 3,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "fixture",
    })
    .returning();
  if (!product) throw new Error("Missing test product");
  const lines = [{ kind: "product", productId: product.id, quantity: 1 }];
  const create = (input: { appointmentId: string } | { clientId: string }) =>
    json(
      t.app,
      "/admin/commerce/checkouts",
      "POST",
      {
        ...input,
        lines,
        idempotencyKey: crypto.randomUUID(),
      },
      owner.cookie,
    );
  const retail = await create({ appointmentId: second });
  expect(retail.status, await retail.clone().text()).toBe(201);
  const visit = visitCheckoutSchema.parse(await (await prepare(first)).json());
  expect(visit.paymentReview?.totalCents).toBe(3600);
  if (!visit.paymentReview) throw new Error("Missing payment review");
  const [payment, walkIn] = await Promise.all([
    collect(first, {
      method: "external_card",
      reviewToken: visit.paymentReview.token,
      idempotencyKey: crypto.randomUUID(),
    }),
    create({ clientId: f.clientId }),
  ]);
  expect(payment.status, await payment.clone().text()).toBe(201);
  expect(walkIn.status, await walkIn.clone().text()).toBe(201);
  const [stock] = await t.db.select().from(retailProduct).where(eq(retailProduct.id, product.id));
  expect(stock).toMatchObject({ stockOnHand: 2, stockReserved: 1 });
});

test("a balance changed after review prevents all visit payments", async () => {
  const { first, second } = await group("import");
  const reviewToken = await paymentReview(first);
  const prepared = visitCheckoutSchema.parse(await (await prepare(first)).json());
  const receipt = prepared.appointments.find((part) => part.appointmentId === second)?.receipt;
  if (!receipt) throw new Error("Missing second receipt");
  const individual = await json(
    t.app,
    `/admin/commerce/checkouts/${receipt.id}/payments`,
    "POST",
    {
      method: "external_card",
      amountCents: 400,
      idempotencyKey: crypto.randomUUID(),
    },
    owner.cookie,
  );
  expect(individual.status).toBe(201);
  const input = { method: "external_card", idempotencyKey: crypto.randomUUID(), reviewToken };
  expect((await collect(first, input)).status).toBe(409);
  expect((await collect(first, input, staff)).status).toBe(404);
  const payments = await t.db.select().from(checkoutPayment);
  expect(payments.map((p) => p.amountCents)).toEqual([400]);
});

test.each(["itinerary", "import"] as const)(
  "the %s group prepares one frozen receipt per professional",
  async (source) => {
    const { groupId, first, second } = await group(source);
    const existing = await json(
      t.app,
      "/admin/commerce/checkouts",
      "POST",
      {
        appointmentId: first,
        idempotencyKey: crypto.randomUUID(),
      },
      owner.cookie,
    );
    expect(existing.status).toBe(201);
    const saved = checkoutSchema.parse(await existing.json());
    const payment = await json(
      t.app,
      `/admin/commerce/checkouts/${saved.id}/payments`,
      "POST",
      { method: "external_card", amountCents: 400, idempotencyKey: crypto.randomUUID() },
      owner.cookie,
    );
    expect(payment.status, await payment.clone().text()).toBe(201);
    const replies = await Promise.all([prepare(second), prepare(first)]);
    const receiptIds = [];
    for (const reply of replies) {
      expect(reply.status, await reply.clone().text()).toBe(200);
      const view = visitCheckoutSchema.parse(await reply.json());
      expect(view.groupId).toBe(groupId);
      receiptIds.push(view.appointments.map(({ receipt }) => receipt?.id));
      expect(view.appointments.map((item) => item.receipt)).toEqual([
        expect.objectContaining({
          id: saved.id,
          appointmentId: first,
          staffId: f.anaId,
          paidCents: 400,
          balanceCents: 800,
        }),
        expect.objectContaining({ appointmentId: second, staffId: f.beaId, balanceCents: 1900 }),
      ]);
    }
    expect(receiptIds[0]).toEqual(receiptIds[1]);
    expect(await t.db.select().from(checkout)).toHaveLength(2);
  },
);

test("a whole visit is hidden from operators restricted to their own receipts", async () => {
  const { first } = await group("itinerary");
  expect((await prepare(first, staff)).status).toBe(404);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("first-time group and individual preparations share the same receipts", async () => {
  const { first, second } = await group("itinerary");
  const [one, two, individual] = await Promise.all([
    prepare(first),
    prepare(second),
    json(
      t.app,
      "/admin/commerce/checkouts",
      "POST",
      { appointmentId: second, idempotencyKey: crypto.randomUUID() },
      owner.cookie,
    ),
  ]);
  expect([one.status, two.status, individual.status]).toEqual([200, 200, 201]);
  const a = visitCheckoutSchema.parse(await one.json());
  const b = visitCheckoutSchema.parse(await two.json());
  const receipt = checkoutSchema.parse(await individual.json());
  expect(a.appointments.map(({ receipt }) => receipt?.id)).toEqual(
    b.appointments.map(({ receipt }) => receipt?.id),
  );
  expect(a.appointments[1]?.receipt?.id).toBe(receipt.id);
  expect(await t.db.select().from(checkout)).toHaveLength(2);
});

test("a legacy billing hold anywhere in the group prevents preparing receipts", async () => {
  const { first, second } = await group("import");
  await t.db.insert(appointmentContext).values({
    appointmentId: second,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "fixture",
    invoiced: true,
  });
  expect((await prepare(first)).status).toBe(409);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("a failure preparing the second part rolls back the first receipt", async () => {
  const { first, second } = await group("itinerary");
  await t.db.delete(appointmentService).where(eq(appointmentService.appointmentId, second));
  expect((await prepare(first)).status).toBe(400);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test("a cancelled appointment stays visible without creating a receipt", async () => {
  const { first, second } = await group("itinerary");
  await t.db.update(appointment).set({ status: "cancelled" }).where(eq(appointment.id, second));
  const result = await prepare(first);
  expect(result.status, await result.clone().text()).toBe(200);
  const view = visitCheckoutSchema.parse(await result.json());
  expect(view.appointments.map(({ receipt }) => receipt?.appointmentId ?? null)).toEqual([
    first,
    null,
  ]);
  expect(await t.db.select().from(checkout)).toHaveLength(1);
});

test("a cancelled appointment retains the receipt that was created before cancellation", async () => {
  const { first, second } = await group("itinerary");
  const initial = visitCheckoutSchema.parse(await (await prepare(first)).json());
  await t.db.update(appointment).set({ status: "cancelled" }).where(eq(appointment.id, second));
  const view = visitCheckoutSchema.parse(await (await prepare(first)).json());
  expect(view.appointments[1]).toMatchObject({
    status: "cancelled",
    receipt: { id: initial.appointments[1]?.receipt?.id },
  });
  expect(await t.db.select().from(checkout)).toHaveLength(2);
});

test("an externally settled part remains noncollectible while its sibling gets a receipt", async () => {
  const { first, second } = await group("import");
  await t.db.insert(appointmentContext).values({
    appointmentId: second,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "settled-fixture",
    invoiced: true,
  });
  const settled = await json(
    t.app,
    `/admin/commerce/appointments/${second}/imported-settlement`,
    "PUT",
    { amountCents: 1900, appointmentVersion: 1, reference: "Synthetic invoice" },
    owner.cookie,
  );
  expect(settled.status, await settled.clone().text()).toBe(200);
  const view = visitCheckoutSchema.parse(await (await prepare(first)).json());
  expect(view.appointments[1]).toMatchObject({ settledExternally: true, receipt: null });
  expect(view.appointments[0]?.receipt?.appointmentId).toBe(first);
  expect(await t.db.select().from(checkout)).toHaveLength(1);
});
