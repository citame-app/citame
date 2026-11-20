import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  adminServiceSchema,
  appointmentSchema,
  type Checkout,
  checkoutSchema,
} from "@sob/contracts";
import { service } from "@sob/db";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>, f: Fixtures, owner: Actor, client: Actor;
let currentNow = NOW;
beforeAll(async () => {
  t = await setupApiTest({ deps: { now: () => currentNow } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  currentNow = NOW;
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
  client = await actor(t, "client", "client@example.com");
});
const call = (path: string, method: string, body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
test("an older client cannot reserve an unresolved price without reviewing its pricing terms", async () => {
  const created = adminServiceSchema.parse(
    await (
      await call("/admin/services", "POST", {
        name: "Unpriced treatment",
        priceType: "variable",
        durationMinutes: 30,
        currency: "EUR",
        staffIds: [f.anaId],
      })
    ).json(),
  );
  const request = { staffId: f.anaId, serviceIds: [created.id], startsAt: MONDAY_0900 };
  expect((await call("/appointments", "POST", request, client)).status).toBe(409);
});
function firstLine(sale: Checkout) {
  const line = sale.lines[0];
  if (!line) throw new Error("Missing service receipt line");
  return line;
}
async function book(priceType: string, priceCents = 0, accepted: Record<string, unknown> = {}) {
  const result = await call("/admin/services", "POST", {
    name: "Bespoke colour",
    priceType,
    priceCents,
    currency: "EUR",
    durationMinutes: 60,
    staffIds: [f.anaId],
  });
  expect(result.status).toBe(201);
  const service = adminServiceSchema.parse(await result.json());
  expect(service).toMatchObject({ priceType });
  const booking = await call(
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [service.id],
      startsAt: MONDAY_0900,
      ...(["variable", "from"].includes(priceType) ? { priceTermsAccepted: true } : {}),
      ...accepted,
    },
    client,
  );
  expect(booking.status).toBe(201);
  const appointment = appointmentSchema.parse(await booking.json());
  expect(appointment.services[0]).toMatchObject({ priceType });
  const sale = await call(
    "/me/checkouts",
    "POST",
    { appointmentId: appointment.id, idempotencyKey: crypto.randomUUID() },
    client,
  );
  expect(sale.status).toBe(201);
  return { service, appointment, sale: checkoutSchema.parse(await sale.json()) };
}
test("variable service prices are frozen as unresolved and cannot become free fulfilled sales", async () => {
  const { sale } = await book("variable");
  expect(sale).toMatchObject({ status: "open", fulfilledAt: null });
  expect(sale.lines[0]).toMatchObject({ pricePending: true });
  const attempt = await call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
    method: "external_card",
    amountCents: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(attempt.status).toBe(409);
});
test("walk-in receipts require a final catalog price before money is collected", async () => {
  const { service } = await book("from", 3000);
  const response = await call("/admin/commerce/checkouts", "POST", {
    idempotencyKey: crypto.randomUUID(),
    lines: [{ kind: "service", serviceId: service.id, quantity: 2 }],
  });
  expect(response.status).toBe(201);
  const sale = checkoutSchema.parse(await response.json());
  expect(sale.appointmentId).toBeNull();
  expect(sale.lines[0]).toMatchObject({ pricePending: true, minimumUnitAmountCents: 3000 });
  expect(
    (await call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
      method: "external_card",
      amountCents: 3000,
      idempotencyKey: crypto.randomUUID(),
    })).status,
  ).toBe(409);
  const finalized = await call(`/admin/commerce/checkouts/${sale.id}/prices`, "PUT", {
    version: sale.pricingVersion,
    lines: [{ id: firstLine(sale).id, unitAmountCents: 4000 }],
  });
  expect(finalized.status).toBe(200);
  expect(checkoutSchema.parse(await finalized.json())).toMatchObject({ totalCents: 8000 });
});

test("only the team can set the reviewed final price and stale changes cannot rewrite it", async () => {
  const { sale } = await book("variable");
  const body = { version: 1, lines: [{ id: firstLine(sale).id, unitAmountCents: 7500 }] };
  expect(
    (await call(`/admin/commerce/checkouts/${sale.id}/prices`, "PUT", body, client)).status,
  ).toBe(403);
  const changed = await call(`/admin/commerce/checkouts/${sale.id}/prices`, "PUT", body);
  expect(changed.status).toBe(200);
  const updated = checkoutSchema.parse(await changed.json());
  expect(updated).toMatchObject({ totalCents: 7500, pricingVersion: 2, fulfilledAt: null });
  expect(updated.lines[0]).toMatchObject({ pricePending: false, unitAmountCents: 7500 });
  expect(
    (
      await call(`/admin/commerce/checkouts/${sale.id}/prices`, "PUT", {
        ...body,
        lines: [{ ...body.lines[0], unitAmountCents: 7000 }],
      })
    ).status,
  ).toBe(409);
  const paid = await call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
    method: "external_card",
    amountCents: 7500,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(paid.status).toBe(201);
  const final = await call(`/admin/commerce/checkouts/${sale.id}`, "GET");
  expect(checkoutSchema.parse(await final.json()).fulfilledAt).not.toBeNull();
});

test("a variable service takes a disclosed fixed deposit without treating its provisional receipt as a finished sale", async () => {
  await t.db.update(service).set({ currency: "EUR" });
  const configured = await call("/admin/settings/booking-policy", "PUT", {
    enabled: true,
    depositKind: "fixed",
    depositValue: 2000,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 2500,
    noShowBasisPoints: 5000,
    trustedExempt: false,
    version: 1,
  });
  expect(configured.status).toBe(200);
  const { version } = (await configured.json()) as { version: number };
  const {
    sale,
    appointment,
    service: variableService,
  } = await book("variable", 0, {
    protectionAcceptedVersion: version,
    protectionAcceptedTotalCents: 0,
    protectionAcceptedDepositCents: 2000,
  });
  const unreviewedDeposit = await call(
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [variableService.id],
      startsAt: "2026-03-09T15:00:00.000Z",
      priceTermsAccepted: true,
      protectionAcceptedVersion: version,
      protectionAcceptedTotalCents: 0,
    },
    client,
  );
  expect(unreviewedDeposit.status).toBe(409);
  expect(await unreviewedDeposit.text()).toContain("exact fixed deposit");
  expect(sale.protection?.depositCents).toBe(2000);
  expect(sale.totalCents).toBe(2000);
  expect(
    (
      await call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 2000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  const held = checkoutSchema.parse(
    await (await call(`/admin/commerce/checkouts/${sale.id}`, "GET")).json(),
  );
  expect(held).toMatchObject({ status: "open", fulfilledAt: null });
  expect(held.protection?.state).toBe("confirmed");
  expect(
    (
      await call(`/admin/commerce/checkouts/${sale.id}/prices`, "PUT", {
        version: 1,
        lines: [{ id: firstLine(sale).id, unitAmountCents: 5000 }],
      })
    ).status,
  ).toBe(200);
  const currentVisits = (await (
    await call(
      "/appointments?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z",
      "GET",
      undefined,
      client,
    )
  ).json()) as { appointments: { id: string; version: number }[] };
  const current = currentVisits.appointments.find((a) => a.id === appointment.id);
  if (!current) throw new Error("Missing booked visit");
  currentNow = new Date(appointment.endsAt);
  const completed = await call(`/appointments/${appointment.id}`, "PATCH", {
    version: current.version,
    status: "completed",
  });
  expect(completed.status, await completed.clone().text()).toBe(200);
  expect(
    (
      await call(`/admin/commerce/checkouts/${sale.id}/payments`, "POST", {
        method: "external_card",
        amountCents: 3000,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  const final = checkoutSchema.parse(
    await (await call(`/admin/commerce/checkouts/${sale.id}`, "GET")).json(),
  );
  expect(final).toMatchObject({ status: "paid", totalCents: 5000, paidCents: 5000 });
  expect(final.fulfilledAt).not.toBeNull();
});
test("from prices preserve their promised minimum and price finalisation does not change booking history", async () => {
  const { sale, appointment } = await book("from", 3000);
  const path = `/admin/commerce/checkouts/${sale.id}/prices`;
  expect(
    (
      await call(path, "PUT", {
        version: 1,
        lines: [{ id: firstLine(sale).id, unitAmountCents: 2999 }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(path, "PUT", {
        version: 1,
        lines: [{ id: firstLine(sale).id, unitAmountCents: 5000 }],
      })
    ).status,
  ).toBe(200);
  const visits = await call(
    `/appointments?from=2026-03-01T00:00:00Z&to=2026-03-31T23:59:59Z`,
    "GET",
    undefined,
    client,
  );
  const saved = (await visits.json()) as {
    appointments: { id: string; services: { priceCents: number }[] }[];
  };
  expect(saved.appointments.find((a) => a.id === appointment.id)?.services[0]?.priceCents).toBe(
    3000,
  );
});
