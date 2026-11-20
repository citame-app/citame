import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { waitlistAcceptedSchema, waitlistEntrySchema, waitlistListSchema } from "@sob/contracts";
import { appointment, clientProfile, reminder, service, waitlistOffer } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { runWaitlist } from "./matching";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
let other: Actor;
const now = new Date("2026-03-02T12:00:00Z");
let requestNow = now;
const call = (who: Actor, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "waitlist_matching", deps: { now: () => requestNow } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  requestNow = now;
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client, other] = await Promise.all([
    actor(t, "owner", "wait-owner@test.local"),
    actor(t, "client", "wait-client@test.local"),
    actor(t, "client", "wait-other@test.local"),
  ]);
  expect(
    (
      await call(owner, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(200);
});
const selection = () => ({
  staffId: f.anaId,
  serviceIds: [f.haircutId],
  fromDate: "2026-03-09",
  toDate: "2026-03-09",
  fromTime: "09:00",
  toTime: "10:00",
  idempotencyKey: crypto.randomUUID(),
});
async function join(who = client) {
  const r = await call(who, "/me/waitlist", "POST", selection());
  expect(r.status, await r.clone().text()).toBe(201);
  return waitlistEntrySchema.parse(await r.json());
}
async function list(who = client) {
  const r = await call(who, "/me/waitlist");
  expect(r.status).toBe(200);
  return waitlistListSchema.parse(await r.json());
}
test("a bounded match reserves an expiring offer, hides its slot and only its customer can accept it once", async () => {
  const entry = await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No waitlist offer");
  expect(offered.state).toBe("offered");
  expect(offered.offer.startsAt).toBe("2026-03-09T12:00:00.000Z");
  const available = await call(
    client,
    `/availability?date=2026-03-09&staffId=${f.anaId}&serviceIds=${f.haircutId}`,
  );
  expect(
    ((await available.json()) as { slots: { startsAt: string }[] }).slots.some(
      (s) => s.startsAt === offered.offer?.startsAt,
    ),
  ).toBe(false);
  const request = {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  };
  expect((await call(other, `/me/waitlist/${entry.id}/accept`, "POST", request)).status).toBe(403);
  const normal = await call(owner, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    clientId: other.clientId,
    startsAt: offered.offer.startsAt,
  });
  expect(normal.status).toBe(409);
  const responses = await Promise.all([
    call(client, `/me/waitlist/${entry.id}/accept`, "POST", request),
    call(client, `/me/waitlist/${entry.id}/accept`, "POST", request),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const result = waitlistAcceptedSchema.parse(await responses[0]?.json());
  expect(result.entry.state).toBe("booked");
  expect(result.appointment.clientId).toBe(client.clientId ?? "");
  expect(result.entry).toMatchObject({
    canManage: true,
    bookedAppointment: {
      id: result.appointment.id,
      startsAt: result.appointment.startsAt,
      staffId: f.anaId,
      status: "booked",
    },
  });
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});
test("paused online booking leaves waitlist requests and offers intact until reopening", async () => {
  const entry = await join();
  const setOpen = (onlineBookingEnabled: boolean) =>
    call(owner, "/admin/settings", "PATCH", { onlineBookingEnabled });
  expect((await setOpen(false)).status).toBe(200);
  const blockedJoin = await call(other, "/me/waitlist", "POST", selection());
  expect(blockedJoin.status).toBe(409);
  expect(await blockedJoin.json()).toMatchObject({ error: { code: "online_booking_paused" } });
  expect(await runWaitlist(t.db, { now })).toMatchObject({ offersCreated: 0 });
  expect((await list()).entries[0]).toMatchObject({ id: entry.id, state: "waiting" });

  expect((await setOpen(true)).status).toBe(200);
  expect(await runWaitlist(t.db, { now })).toMatchObject({ offersCreated: 1 });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No waitlist offer");
  const request = {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  };
  expect((await setOpen(false)).status).toBe(200);
  const paused = await call(client, `/me/waitlist/${entry.id}/accept`, "POST", request);
  expect(paused.status).toBe(409);
  expect(await paused.json()).toMatchObject({ error: { code: "online_booking_paused" } });
  expect((await list()).entries[0]).toMatchObject({ id: entry.id, state: "offered" });

  expect((await setOpen(true)).status).toBe(200);
  expect((await call(client, `/me/waitlist/${entry.id}/accept`, "POST", request)).status).toBe(201);
});

test("expired offers release capacity, reject late acceptance and pass the same scarce slot to the next customer", async () => {
  await join();
  await join(other);
  await runWaitlist(t.db, { now });
  const first = (await list()).entries[0];
  if (!first?.offer) throw new Error("No first offer");
  expect((await list(other)).entries[0]?.offer).toBeNull();
  const expiredAt = new Date(first.offer.expiresAt);
  await runWaitlist(t.db, { now: expiredAt });
  const next = (await list(other)).entries[0];
  expect(next?.state).toBe("offered");
  expect(next?.offer?.startsAt).toBe(first.offer.startsAt);
  expect(
    (
      await call(client, `/me/waitlist/${first.id}/accept`, "POST", {
        version: first.version,
        offerId: first.offer.id,
        expectedTotalCents: first.offer.priceCents,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
test("declining and cancellation release a hold without creating any appointment or overriding its revision", async () => {
  const entry = await join();
  await runWaitlist(t.db, { now });
  const first = (await list()).entries[0];
  if (!first?.offer) throw new Error("No offer");
  const r = await call(client, `/me/waitlist/${entry.id}/decline`, "POST", {
    version: first.version,
    offerId: first.offer.id,
    requeue: true,
  });
  expect(r.status).toBe(200);
  const waiting = waitlistEntrySchema.parse(await r.json());
  expect(waiting.state).toBe("waiting");
  expect(waiting.offer).toBeNull();
  expect(
    (await call(client, `/me/waitlist/${entry.id}/cancel`, "POST", { version: first.version }))
      .status,
  ).toBe(409);
  expect(
    (await call(client, `/me/waitlist/${entry.id}/cancel`, "POST", { version: waiting.version }))
      .status,
  ).toBe(200);
  await runWaitlist(t.db, { now: new Date(now.getTime() + 3600000) });
  expect((await list()).entries[0]?.state).toBe("cancelled");
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
test("changed offer prices cannot silently rewrite the accepted booking total", async () => {
  const entry = await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No offer");
  await t.db.update(service).set({ priceCents: 20000 }).where(eq(service.id, f.haircutId));
  expect(
    (
      await call(client, `/me/waitlist/${entry.id}/accept`, "POST", {
        version: offered.version,
        offerId: offered.offer.id,
        expectedTotalCents: offered.offer.priceCents,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});

test("acceptance checks the exact deadline before any cleanup process has run", async () => {
  const entry = await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No offer");
  requestNow = new Date(offered.offer.expiresAt);
  expect(
    (
      await call(client, `/me/waitlist/${entry.id}/accept`, "POST", {
        version: offered.version,
        offerId: offered.offer.id,
        expectedTotalCents: offered.offer.priceCents,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect((await t.db.select().from(waitlistOffer))[0]?.state).toBe("offered");
});
test("concurrent matching workers publish only one hold per entry and do not double-book a scarce slot", async () => {
  await join();
  await join(other);
  await Promise.all([
    runWaitlist(t.db, { now }),
    runWaitlist(t.db, { now }),
    runWaitlist(t.db, { now }),
  ]);
  const offers = await t.db.select().from(waitlistOffer);
  expect(offers).toHaveLength(1);
  expect(offers[0]?.state).toBe("offered");
});
test("accepted protected offers still need the current deposit consent and do not send a confirmation before funding", async () => {
  await t.db.update(service).set({ currency: "EUR" });
  const policyResponse = await call(owner, "/admin/settings/booking-policy");
  expect(policyResponse.status).toBe(200);
  const policy = (await policyResponse.json()) as Record<string, unknown>;
  expect(
    (await call(owner, "/admin/settings/booking-policy", "PUT", { ...policy, enabled: true }))
      .status,
  ).toBe(200);
  const entry = await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No protected offer");
  const request = {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  };
  expect((await call(client, `/me/waitlist/${entry.id}/accept`, "POST", request)).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const r = await call(client, `/me/waitlist/${entry.id}/accept`, "POST", {
    ...request,
    protectionAcceptedVersion: offered.offer.policy.version,
    protectionAcceptedTotalCents: offered.offer.priceCents,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const result = waitlistAcceptedSchema.parse(await r.json());
  expect(result.appointment.protection).toMatchObject({ state: "pending", depositCents: 2500 });
  expect(await t.db.select().from(reminder)).toHaveLength(0);
});
test("a blocked profile is not offered capacity and a block after an offer prevents acceptance", async () => {
  await join();
  await t.db
    .update(clientProfile)
    .set({ bookingAccess: "blocked", bookingAccessReason: "Private salon restriction" })
    .where(eq(clientProfile.id, client.clientId ?? ""));
  await runWaitlist(t.db, { now });
  const closed = await list();
  expect(closed.entries[0]?.state).toBe("unavailable");
  expect(JSON.stringify(closed)).not.toContain("Private salon restriction");
  const entry = await join(other);
  await runWaitlist(t.db, { now });
  const offered = (await list(other)).entries[0];
  if (!offered?.offer) throw new Error("No second offer");
  await t.db
    .update(clientProfile)
    .set({ bookingAccess: "blocked" })
    .where(eq(clientProfile.id, other.clientId ?? ""));
  expect(
    (
      await call(other, `/me/waitlist/${entry.id}/accept`, "POST", {
        version: offered.version,
        offerId: offered.offer.id,
        expectedTotalCents: offered.offer.priceCents,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  await runWaitlist(t.db, { now });
  const withdrawn = (await list(other)).entries[0];
  expect(withdrawn?.state).toBe("unavailable");
  expect(withdrawn?.offer).toBeNull();
});
test("an offer deadline preserves the minimum notice so accepting an unexpired hold still creates a valid booking", async () => {
  const joined = await call(client, "/me/waitlist", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    fromDate: "2026-03-02",
    toDate: "2026-03-02",
    fromTime: "10:00",
    toTime: "12:00",
    idempotencyKey: crypto.randomUUID(),
  });
  expect(joined.status).toBe(201);
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No notice-preserving offer");
  expect(offered.offer.startsAt).toBe("2026-03-02T13:30:00.000Z");
  requestNow = new Date(Date.parse(offered.offer.expiresAt) - 1);
  const r = await call(client, `/me/waitlist/${offered.id}/accept`, "POST", {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
});

test("an operator cannot replay an accepted offer to read a visit moved off their calendar", async () => {
  const ana = await actor(t, "staff", "wait-ana@test.local", { staffProfileId: f.anaId });
  const entry = await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  if (!offered?.offer) throw new Error("No offer");
  const body = {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  };
  const accepted = await call(ana, `/admin/waitlist/${entry.id}/accept`, "POST", body);
  expect(accepted.status).toBe(201);
  const result = waitlistAcceptedSchema.parse(await accepted.json());
  expect(
    (
      await call(owner, `/appointments/${result.appointment.id}`, "PATCH", {
        version: result.appointment.version,
        staffId: f.beaId,
      })
    ).status,
  ).toBe(200);
  expect((await call(ana, `/admin/waitlist/${entry.id}/accept`, "POST", body)).status).toBe(403);
});

test("removing the offered professional's qualification withdraws that hold instead of blocking other services until expiry", async () => {
  await join();
  await runWaitlist(t.db, { now });
  const offered = (await list()).entries[0];
  expect(offered?.state).toBe("offered");
  await t.db.execute(
    sql`update service_staff set deleted_at=${now} where staff_id=${f.anaId} and service_id=${f.haircutId}`,
  );
  await runWaitlist(t.db, { now });
  const released = (await list()).entries[0];
  expect(released?.state).toBe("unavailable");
  expect(released?.offer).toBeNull();
});

test("the daily offer cap includes an offer published exactly at salon-local midnight", async () => {
  requestNow = new Date("2026-03-02T03:00:00.000Z");
  await join();
  for (let i = 0; i < 3; i++) {
    await runWaitlist(t.db, { now: requestNow });
    const entry = (await list()).entries[0];
    if (!entry?.offer) throw new Error("Missing allowed daily offer");
    expect(
      (
        await call(client, `/me/waitlist/${entry.id}/decline`, "POST", {
          version: entry.version,
          offerId: entry.offer.id,
          requeue: true,
        })
      ).status,
    ).toBe(200);
    requestNow = new Date(requestNow.getTime() + 16 * 60000);
  }
  await runWaitlist(t.db, { now: requestNow });
  const capped = (await list()).entries[0];
  expect(capped?.state).toBe("waiting");
  expect(capped?.offer).toBeNull();
});
