import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { resourceReservation, service, waitlistOffer } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { lockScheduling } from "../../tx";
import { expireBookingHolds } from "../booking-protection/value";
import { runWaitlist } from "../waitlist/matching";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let professional: Actor;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "resources" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  await t.db.update(service).set({ currency: "EUR" });
  [owner, client, professional] = await Promise.all([
    actor(t, "owner", "resources-owner@test.local"),
    actor(t, "client", "resources-client@test.local"),
    actor(t, "staff", "resources-professional@test.local", { staffProfileId: f.anaId }),
  ]);
});
async function pool(capacity = 1) {
  const r = await call(owner, "/admin/resources", "POST", {
    name: "Treatment rooms",
    kind: "room",
    capacity,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { id: string; version: number; capacity: number; active: boolean };
}
async function requirements(resourceId: string, quantity = 1, version = 1) {
  const r = await call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
    version,
    requirements: [{ resourceId, quantity }],
  });
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { version: number };
}
const book = (staffId: string, startsAt = "2026-03-09T12:00:00.000Z") =>
  call(owner, "/appointments", "POST", {
    staffId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt,
  });
test("resource administration is restricted and requirements start empty without changing ordinary booking", async () => {
  expect((await call(null, "/admin/resources")).status).toBe(401);
  expect((await call(client, "/admin/resources")).status).toBe(403);
  expect((await call(professional, "/admin/resources")).status).toBe(403);
  const r = await call(owner, `/admin/services/${f.haircutId}/resources`);
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ version: 1, requirements: [] });
  expect((await book(f.anaId)).status).toBe(201);
  expect((await book(f.beaId)).status).toBe(201);
});
test("a shared resource with capacity one serializes simultaneous bookings on different professionals", async () => {
  const resource = await pool();
  await requirements(resource.id);
  const results = await Promise.all([book(f.anaId), book(f.beaId)]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const successful = results.find((r) => r.status === 201);
  if (!successful) throw new Error("No winning booking");
  const created = (await successful.json()) as { id: string; version: number; staffId: string };
  const other = created.staffId === f.anaId ? f.beaId : f.anaId;
  const availability = await call(
    owner,
    `/availability?date=2026-03-09&staffId=${other}&serviceIds=${f.haircutId}`,
  );
  expect(
    ((await availability.json()) as { slots: { startsAt: string }[] }).slots.some(
      (s) => s.startsAt === "2026-03-09T12:00:00.000Z",
    ),
  ).toBe(false);
  expect(
    (
      await call(owner, `/appointments/${created.id}`, "PATCH", {
        version: created.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect((await book(other)).status).toBe(201);
});
test("pool edits and service requirements require current revisions and cannot claim more capacity than exists", async () => {
  const resource = await pool(2);
  await requirements(resource.id, 2);
  expect(
    (
      await call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [],
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 2,
        requirements: [{ resourceId: resource.id, quantity: 3 }],
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call(owner, `/admin/resources/${resource.id}`, "PUT", {
        version: resource.version,
        name: "Treatment rooms",
        kind: "room",
        capacity: 2,
        active: true,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await call(owner, `/admin/resources/${resource.id}`, "PUT", {
        version: resource.version,
        name: "Old revision",
        kind: "room",
        capacity: 1,
        active: true,
      })
    ).status,
  ).toBe(409);
});

test("new requirements account for already scheduled visits and roll back an impossible capacity change", async () => {
  const first = await book(f.anaId);
  const second = await book(f.beaId);
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  const a = (await first.json()) as { id: string; version: number };
  const b = (await second.json()) as { id: string; version: number };
  const resource = await pool();
  expect(
    (
      await call(owner, `/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: resource.id, quantity: 1 }],
      })
    ).status,
  ).toBe(409);
  expect(
    await (await call(owner, `/admin/services/${f.haircutId}/resources`)).json(),
  ).toMatchObject({ version: 1, requirements: [] });
  expect(
    (
      await call(owner, `/appointments/${b.id}`, "PATCH", {
        version: b.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  await requirements(resource.id);
  expect((await book(f.beaId)).status).toBe(409);
  expect(
    (
      await call(owner, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect((await book(f.beaId)).status).toBe(201);
});

test("appointment payments wait for resource reconfiguration before changing the receipt", async () => {
  const booking = await book(f.anaId);
  expect(booking.status).toBe(201);
  const a = (await booking.json()) as { id: string };
  const sale = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: a.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(sale.status, await sale.clone().text()).toBe(201);
  const receipt = (await sale.json()) as { id: string };
  let unlock!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const released = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const configuration = t.db.transaction(async (tx) => {
    await lockScheduling(tx);
    locked();
    await released;
  });
  await ready;
  const payment = call(owner, `/admin/commerce/checkouts/${receipt.id}/payments`, "POST", {
    method: "external_card",
    amountCents: 10000,
    idempotencyKey: crypto.randomUUID(),
  });
  try {
    const state = await Promise.race([
      Promise.resolve(payment).then(() => "settled"),
      Bun.sleep(300).then(() => "waiting"),
    ]);
    expect(state).toBe("waiting");
    expect(
      await (await call(owner, `/admin/commerce/checkouts/${receipt.id}`)).json(),
    ).toMatchObject({ paidCents: 0 });
  } finally {
    unlock();
    await configuration;
    expect((await payment).status).toBe(201);
  }
});

test("rescheduling availability excludes only the authorized visit and preserves its booked duration", async () => {
  const resource = await pool();
  await requirements(resource.id);
  const a = (await (await book(f.anaId)).json()) as { id: string; version: number };
  await t.db.update(service).set({ durationMinutes: 105, bufferMinutes: 15 });
  const path = `/appointments/${a.id}/availability?date=2026-03-09&staffId=${f.beaId}&serviceIds=${f.haircutId}`;
  expect((await call(null, path)).status).toBe(401);
  expect((await call(client, path)).status).toBe(403);
  expect((await call(professional, path)).status).toBe(403);
  const r = await call(owner, path);
  expect(r.status, await r.clone().text()).toBe(200);
  expect(((await r.json()) as { slots: unknown[] }).slots).toContainEqual({
    staffId: f.beaId,
    startsAt: "2026-03-09T12:00:00.000Z",
    endsAt: "2026-03-09T13:00:00.000Z",
  });
  expect((await call(owner, path.replace(f.haircutId, f.colorId))).status).toBe(400);
  expect(
    (
      await call(owner, `/appointments/${a.id}`, "PATCH", {
        version: a.version,
        staffId: f.beaId,
        startsAt: "2026-03-09T12:00:00.000Z",
      })
    ).status,
  ).toBe(200);
  expect((await book(f.anaId)).status).toBe(409);
});

test("calendar resource summaries retain the allocated quantities", async () => {
  const resource = await pool(2);
  await requirements(resource.id, 2);
  const a = (await (await book(f.anaId)).json()) as { id: string };
  const r = await call(
    owner,
    "/appointments/calendar?from=2026-03-09T00:00:00.000Z&to=2026-03-10T00:00:00.000Z",
  );
  expect(r.status).toBe(200);
  expect(
    (
      (await r.json()) as { appointments: { id: string; resources?: unknown[] }[] }
    ).appointments.find((b) => b.id === a.id)?.resources,
  ).toEqual([{ name: "Treatment rooms", quantity: 2 }]);
});
test("deposit expiry releases shared capacity even when it cancels outside the regular appointment command", async () => {
  const resource = await pool();
  await requirements(resource.id);
  const policy = await call(owner, "/admin/settings/booking-policy", "PUT", {
    enabled: true,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 2500,
    noShowBasisPoints: 5000,
    trustedExempt: true,
    version: 1,
  });
  expect(policy.status).toBe(200);
  const r = await call(client, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    protectionAcceptedVersion: 2,
    protectionAcceptedTotalCents: 10000,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const a = (await r.json()) as { id: string };
  expect((await book(f.beaId)).status).toBe(409);
  await expireBookingHolds(t.db, new Date(NOW.getTime() + 15 * 60000));
  const rows = await t.db
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.appointmentId, a.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.active).toBe(false);
  const next = await call(owner, "/appointments", "POST", {
    staffId: f.beaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    protectionWaiverReason: "Manager fixture waiver",
  });
  expect(next.status, await next.clone().text()).toBe(201);
});
test("waitlist offers hold shared capacity and expired offers release it before bounded worker cleanup", async () => {
  const resource = await pool();
  await requirements(resource.id);
  expect(
    (
      await call(owner, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(200);
  const joined = await call(client, "/me/waitlist", "POST", {
    serviceIds: [f.haircutId],
    staffId: f.anaId,
    fromDate: "2026-03-09",
    toDate: "2026-03-09",
    fromTime: "09:00",
    toTime: "10:00",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(joined.status).toBe(201);
  const entry = (await joined.json()) as { id: string };
  await runWaitlist(t.db, { now: NOW });
  const [offer] = await t.db
    .select()
    .from(waitlistOffer)
    .where(eq(waitlistOffer.entryId, entry.id));
  expect(offer?.state).toBe("offered");
  expect((await book(f.beaId)).status).toBe(409);
  if (!offer) throw new Error("Missing offer");
  await t.db.update(waitlistOffer).set({ expiresAt: NOW }).where(eq(waitlistOffer.id, offer.id));
  expect((await book(f.beaId)).status).toBe(201);
  const [released] = await t.db
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.offerId, offer.id));
  expect(released).toMatchObject({ active: false, released: true });
  const [unchanged] = await t.db.select().from(waitlistOffer).where(eq(waitlistOffer.id, offer.id));
  expect(unchanged?.state).toBe("offered");
});
