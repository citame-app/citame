import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, pgErrorCode, resourceReservation, service, staffReservation } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "processing_capacity_import" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@processing.test");
});
const call = (path: string, method = "GET", input?: unknown, who = owner) =>
  json(t.app, path, method, input, who.cookie);
async function configure() {
  const response = await call(`/admin/services/${f.colorId}/processing`, "PUT", {
    version: 1,
    processing: { startsAfterMinutes: 30, minutes: 30 },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await t.db
    .update(service)
    .set({ durationMinutes: 30, bufferMinutes: 0 })
    .where(eq(service.id, f.haircutId));
}
async function book(serviceId: string, startsAt = MONDAY_0900) {
  return call("/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [serviceId],
    startsAt,
    clientId: f.clientId,
  });
}
async function capacity(maxConcurrent: number, version = 1) {
  return call(`/admin/staff/${f.anaId}/capacity`, "PUT", {
    maxConcurrent,
    version,
    confirmed: true,
  });
}
test("processing frees only the hands-off middle while the visit duration and cleanup remain frozen", async () => {
  await configure();
  const response = await book(f.colorId);
  expect(response.status).toBe(201);
  const visit = (await response.json()) as { endsAt: string; services: { processing: unknown }[] };
  expect(visit.endsAt).toBe("2026-03-09T13:30:00.000Z");
  expect(visit.services[0]?.processing).toEqual({ startsAfterMinutes: 30, minutes: 30 });
  const available = await call(
    `/availability?date=${MONDAY}&staffId=${f.anaId}&serviceIds=${f.haircutId}`,
  );
  expect(
    ((await available.json()) as { slots: { startsAt: string }[] }).slots.map((s) => s.startsAt),
  ).toContain("2026-03-09T12:30:00.000Z");
  expect((await book(f.haircutId, "2026-03-09T12:30:00.000Z")).status).toBe(201);
  expect((await book(f.haircutId, "2026-03-09T13:00:00.000Z")).status).toBe(409);
});
test("parallel capacity defaults to one and concurrent callers cannot exceed an explicitly configured limit", async () => {
  const initial = await call(`/admin/staff/${f.anaId}/capacity`);
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({ maxConcurrent: 1, version: 1 });
  expect((await capacity(2)).status).toBe(200);
  const responses = await Promise.all(Array.from({ length: 8 }, () => book(f.haircutId)));
  expect(responses.filter((r) => r.status === 201)).toHaveLength(2);
  expect(responses.filter((r) => r.status === 409)).toHaveLength(6);
  expect((await capacity(1, 2)).status).toBe(409);
  const visits = await t.db.select().from(appointment);
  const cancelled = visits[0];
  if (!cancelled) throw new Error("Missing fixture visit");
  expect(
    (
      await call(`/appointments/${cancelled.id}`, "PATCH", {
        version: cancelled.version,
        status: "cancelled",
      })
    ).status,
  ).toBe(200);
  expect((await capacity(1, 2)).status).toBe(200);
  expect((await book(f.haircutId)).status).toBe(409);
});
test("catalog edits do not remove the old processing gap and moving a visit retains its frozen work plan", async () => {
  await configure();
  const response = await book(f.colorId);
  expect(response.status).toBe(201);
  const visit = (await response.json()) as { id: string; version: number };
  expect(
    (await call(`/admin/services/${f.colorId}/processing`, "PUT", { version: 2, processing: null }))
      .status,
  ).toBe(200);
  expect((await book(f.haircutId, "2026-03-09T12:30:00.000Z")).status).toBe(201);
  const moved = await call(`/appointments/${visit.id}`, "PATCH", {
    version: visit.version,
    startsAt: "2026-03-09T14:00:00.000Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  expect(await moved.json()).toMatchObject({
    endsAt: "2026-03-09T15:30:00.000Z",
    services: [{ processing: { startsAfterMinutes: 30, minutes: 30 } }],
  });
  expect((await book(f.haircutId, "2026-03-09T14:30:00.000Z")).status).toBe(201);
});
test("the database backstop protects capacity even when raw SQL skips the appointment service", async () => {
  expect((await capacity(2)).status).toBe(200);
  const row = {
    staffId: f.anaId,
    clientId: f.clientId,
    startsAt: new Date(MONDAY_0900),
    endsAt: new Date("2026-03-09T13:00:00Z"),
  };
  await t.db.insert(appointment).values(row);
  await t.db.insert(appointment).values(row);
  let error: unknown;
  try {
    await t.db.insert(appointment).values(row);
  } catch (caught) {
    error = caught;
  }
  expect(pgErrorCode(error)).toBe("23P01");
});

test("frozen Booksy overlaps consume capacity and moving a legacy visit uses regular capacity", async () => {
  const sameTime = {
    staffId: f.anaId,
    clientId: f.clientId,
    startsAt: new Date(MONDAY_0900),
    endsAt: new Date("2026-03-09T13:00:00Z"),
  };
  const visitIds = await t.db.transaction(async (tx) => {
    const imported = await tx
      .insert(appointment)
      .values(
        [1, 2].map(() => ({
          ...sameTime,
          visitGroupId: Bun.randomUUIDv7(),
          sourceStaffWindow: {
            staffId: sameTime.staffId,
            startsAt: sameTime.startsAt.toISOString(),
            endsAt: sameTime.endsAt.toISOString(),
          },
        })),
      )
      .returning({ id: appointment.id });
    for (const [index, row] of imported.entries())
      await tx
        .update(staffReservation)
        .set({ unitIndex: 6 + index })
        .where(eq(staffReservation.appointmentId, row.id));
    return imported.map(({ id }) => id);
  });
  expect(await (await call(`/admin/staff/${f.anaId}/capacity`)).json()).toMatchObject({
    maxConcurrent: 1,
  });
  expect((await book(f.haircutId)).status).toBe(409);
  let directViolation: unknown;
  try {
    await t.db.insert(appointment).values(sameTime);
  } catch (error) {
    directViolation = error;
  }
  expect(pgErrorCode(directViolation)).toBe("23P01");
  const regular = await book(f.haircutId, "2026-03-09T13:00:00Z");
  expect(regular.status, await regular.clone().text()).toBe(201);
  const { id: regularId } = (await regular.json()) as { id: string };
  let invalidSource: unknown;
  try {
    await t.db
      .update(staffReservation)
      .set({ unitIndex: 8 })
      .where(eq(staffReservation.appointmentId, regularId));
  } catch (error) {
    invalidSource = error;
  }
  expect(pgErrorCode(invalidSource)).toBe("23514");
  const moved = await call(`/appointments/${visitIds[0]}`, "PATCH", {
    version: 1,
    startsAt: "2026-03-09T15:00:00Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const [slot] = await t.db
    .select()
    .from(staffReservation)
    .where(eq(staffReservation.appointmentId, visitIds[0]!));
  expect(slot?.unitIndex).toBe(0);
  expect((await book(f.haircutId)).status).toBe(409);
});
test("processing and capacity are versioned manager choices with strict bounds and explicit confirmation", async () => {
  const staff = await actor(t, "staff", "staff@processing.test", { staffProfileId: f.anaId });
  expect(
    (
      await call(
        `/admin/services/${f.colorId}/processing`,
        "PUT",
        { version: 1, processing: { startsAfterMinutes: 30, minutes: 30 } },
        staff,
      )
    ).status,
  ).toBe(403);
  for (const input of [
    { maxConcurrent: 7, version: 1, confirmed: true },
    { maxConcurrent: 2, version: 1, confirmed: false },
    { maxConcurrent: 0, version: 1, confirmed: true },
  ])
    expect((await call(`/admin/staff/${f.anaId}/capacity`, "PUT", input)).status).toBe(400);
  for (const processing of [
    { startsAfterMinutes: 0, minutes: 30 },
    { startsAfterMinutes: 30, minutes: 60 },
  ])
    expect(
      (await call(`/admin/services/${f.colorId}/processing`, "PUT", { version: 1, processing }))
        .status,
    ).toBe(400);
  await configure();
  expect(
    (await call(`/admin/services/${f.colorId}/processing`, "PUT", { version: 1, processing: null }))
      .status,
  ).toBe(409);
});

test("capacity changes serialize with direct calendar writers before inspecting allocations", async () => {
  const { lockCalendars } = await import("../../tx");
  const { sql } = await import("drizzle-orm");
  let ready = () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = t.db.transaction(async (tx) => {
    await lockCalendars(tx, [f.anaId]);
    ready();
    await resume;
  });
  await held;
  const pending = capacity(2);
  try {
    let waiting = false;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    release();
    await writer;
  }
  expect((await pending).status).toBe(200);
});

test("raw SQL capacity changes obey the same calendar lock as allocation triggers", async () => {
  const { lockCalendars } = await import("../../tx");
  const { sql } = await import("drizzle-orm");
  const { staffProfile } = await import("@sob/db");
  let ready = () => {};
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = t.db.transaction(async (tx) => {
    await lockCalendars(tx, [f.anaId]);
    ready();
    await resume;
  });
  await held;
  const pending = t.db
    .update(staffProfile)
    .set({ maxConcurrent: 2 })
    .where(eq(staffProfile.id, f.anaId))
    .then(
      () => true,
      (error) => error,
    );
  try {
    let waiting = false;
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    release();
    await writer;
  }
  expect(await pending).toBe(true);
});

test("a shared room remains occupied during exposure even though the professional is free", async () => {
  await configure();
  const pool = await call("/admin/resources", "POST", {
    name: "Fixture room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(pool.status).toBe(201);
  const resource = (await pool.json()) as { id: string };
  for (const id of [f.haircutId, f.colorId])
    expect(
      (
        await call(`/admin/services/${id}/resources`, "PUT", {
          version: 1,
          requirements: [{ resourceId: resource.id, quantity: 1 }],
        })
      ).status,
    ).toBe(200);
  expect((await book(f.colorId)).status).toBe(201);
  expect((await book(f.haircutId, "2026-03-09T12:30:00.000Z")).status).toBe(409);
});
test("frozen equipment overlaps block new bookings but leave adjacent capacity available", async () => {
  const pool = await call("/admin/resources", "POST", {
    name: "Original room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(pool.status).toBe(201);
  const { id: resourceId } = (await pool.json()) as { id: string };
  expect(
    (
      await call(`/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId, quantity: 1 }],
      })
    ).status,
  ).toBe(200);
  const startsAt = new Date(MONDAY_0900);
  const endsAt = new Date("2026-03-09T13:00:00Z");
  const existing = await t.db.transaction(async (tx) => {
    const visits = await tx
      .insert(appointment)
      .values(
        [f.anaId, f.beaId].map((staffId) => ({
          staffId,
          clientId: f.clientId,
          startsAt,
          endsAt,
          visitGroupId: Bun.randomUUIDv7(),
          sourceResourceWindow: {
            resourceId,
            startsAt: startsAt.toISOString(),
            endsAt: endsAt.toISOString(),
          },
        })),
      )
      .returning({ id: appointment.id });
    await tx.insert(resourceReservation).values(
      visits.map(({ id }, index) => ({
        resourceId,
        appointmentId: id,
        servicePosition: 0,
        offsetMinutes: 0,
        endOffsetMinutes: 60,
        startsAt,
        endsAt,
        name: "Original room",
        unitIndex: 20 + index,
      })),
    );
    return visits;
  });
  const moved = await call(`/appointments/${existing[0]!.id}`, "PATCH", {
    version: 1,
    startsAt: "2026-03-09T14:00:00Z",
  });
  expect(moved.status, await moved.clone().text()).toBe(200);
  const [slot] = await t.db
    .select()
    .from(resourceReservation)
    .where(eq(resourceReservation.appointmentId, existing[0]!.id));
  expect(slot?.unitIndex).toBe(0);
  expect((await book(f.haircutId)).status).toBe(409);
  let rawError: unknown;
  try {
    await t.db.transaction(async (tx) => {
      const [visit] = await tx
        .insert(appointment)
        .values({ staffId: f.anaId, clientId: f.clientId, startsAt, endsAt })
        .returning({ id: appointment.id });
      await tx.insert(resourceReservation).values({
        resourceId,
        appointmentId: visit!.id,
        servicePosition: 0,
        offsetMinutes: 0,
        endOffsetMinutes: 60,
        startsAt,
        endsAt,
        name: "Original room",
        unitIndex: 0,
      });
    });
  } catch (error) {
    rawError = error;
  }
  expect(pgErrorCode(rawError)).toBe("23P01");
  const adjacent = await book(f.haircutId, "2026-03-09T13:00:00Z");
  expect(adjacent.status, await adjacent.clone().text()).toBe(201);
});
test("waitlist offers can use a processing gap, reserve it and transfer the same capacity on acceptance", async () => {
  await configure();
  expect((await book(f.colorId)).status).toBe(201);
  expect(
    (await call("/admin/waitlist/policy", "PUT", { enabled: true, offerMinutes: 30, version: 1 }))
      .status,
  ).toBe(200);
  const customer = await actor(t, "client", "waiting@processing.test");
  const joined = await call(
    "/me/waitlist",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      fromDate: MONDAY,
      toDate: MONDAY,
      fromTime: "09:30",
      toTime: "10:00",
      idempotencyKey: crypto.randomUUID(),
    },
    customer,
  );
  expect(joined.status).toBe(201);
  const { runWaitlist } = await import("../waitlist/matching");
  const { NOW } = await import("../../../test/helpers");
  await runWaitlist(t.db, { now: NOW });
  const listed = await call("/me/waitlist", "GET", undefined, customer);
  const { waitlistListSchema } = await import("@sob/contracts");
  const entry = waitlistListSchema.parse(await listed.json()).entries[0];
  if (!entry?.offer) throw new Error("Missing gap offer");
  expect(entry.offer.startsAt).toBe("2026-03-09T12:30:00.000Z");
  expect((await book(f.haircutId, entry.offer.startsAt)).status).toBe(409);
  const accepted = await call(
    `/me/waitlist/${entry.id}/accept`,
    "POST",
    {
      version: entry.version,
      offerId: entry.offer.id,
      expectedTotalCents: entry.offer.priceCents,
      idempotencyKey: crypto.randomUUID(),
    },
    customer,
  );
  expect(accepted.status, await accepted.clone().text()).toBe(201);
});
test("raw SQL cannot erase occupancy or rewrite frozen work after booking", async () => {
  await configure();
  const response = await book(f.colorId);
  expect(response.status).toBe(201);
  const visit = (await response.json()) as { id: string };
  const { staffReservation } = await import("@sob/db");
  let erased: unknown;
  try {
    await t.db.delete(staffReservation).where(eq(staffReservation.appointmentId, visit.id));
  } catch (error) {
    erased = error;
  }
  expect(pgErrorCode(erased)).toBe("23514");
  let changed: unknown;
  try {
    await t.db
      .update(appointment)
      .set({ workWindows: [{ offsetMinutes: 0, endOffsetMinutes: 90 }] })
      .where(eq(appointment.id, visit.id));
  } catch (error) {
    changed = error;
  }
  expect(pgErrorCode(changed)).toBe("23514");
});
