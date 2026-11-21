import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { desktopVisitPreviewSchema, intakeRequirementsSchema, visitSchema } from "@sob/contracts";
import {
  appointment,
  appointmentVisit,
  migrationsFolder,
  runMigrations,
  service,
  syncChange,
} from "@sob/db";
import { asc, eq, gt, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { getBookableServices } from "../services/service";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "desktop_visits" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
  client = await actor(t, "client", "client@example.com");
});
const packet = () => ({
  id: crypto.randomUUID(),
  startsAt: MONDAY_0900,
  parts: [
    { staffId: f.beaId, serviceIds: [f.haircutId] },
    { staffId: f.anaId, serviceIds: [f.colorId] },
  ],
});

test("one customer confirms a sequential visit with different professionals atomically", async () => {
  const body = packet();
  const response = await json(t.app, "/appointments/visits", "POST", body, client.cookie);
  expect(response.status).toBe(201);
  const result = (await response.json()) as {
    id: string;
    appointments: {
      id: string;
      staffId: string;
      startsAt: string;
      endsAt: string;
      clientId: string;
    }[];
  };
  expect(result.id).toBe(body.id);
  expect(result.appointments.map((a) => a.staffId)).toEqual([f.beaId, f.anaId]);
  expect(result.appointments[1]?.startsAt).toBe(result.appointments[0]?.endsAt);
  expect(new Set(result.appointments.map((a) => a.clientId)).size).toBe(1);
  const replay = await json(t.app, "/appointments/visits", "POST", body, client.cookie);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(result);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
  const changed = await json(
    t.app,
    "/appointments/visits",
    "POST",
    { ...body, notes: "changed intent" },
    client.cookie,
  );
  expect(changed.status).toBe(409);
});

test("a conflict in the second treatment rolls back the entire visit", async () => {
  expect(
    (
      await json(
        t.app,
        "/appointments",
        "POST",
        { staffId: f.anaId, serviceIds: [f.colorId], startsAt: MONDAY_0900, clientId: f.clientId },
        owner.cookie,
      )
    ).status,
  ).toBe(201);
  const result = await json(t.app, "/appointments/visits", "POST", packet(), client.cookie);
  expect(result.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});

test("pausing online booking blocks new public visits and preserves staff booking and replay", async () => {
  const book = (actor: Actor, body: unknown) =>
    json(t.app, "/appointments/visits", "POST", body, actor.cookie);
  const original = { ...packet(), notes: "Customer note for both treatments" };
  const created = await book(client, original);
  expect(created.status).toBe(201);
  expect(
    (await json(t.app, "/admin/settings", "PATCH", { onlineBookingEnabled: false }, owner.cookie))
      .status,
  ).toBe(200);
  expect((await book(client, original)).status).toBe(201);
  const next = { ...packet(), startsAt: "2026-03-16T12:00:00.000Z" };
  const blocked = await book(client, next);
  expect(blocked.status, await blocked.clone().text()).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "online_booking_paused" } });
  expect(await t.db.select().from(appointmentVisit)).toHaveLength(1);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
  expect((await t.db.select().from(appointment)).map((row) => row.customerComment)).toEqual([
    original.notes,
    original.notes,
  ]);
  const staff = await book(owner, { ...next, clientId: f.clientId });
  expect(staff.status, await staff.clone().text()).toBe(201);
});

test("Desktop commits only the reviewed itinerary and never leaves a partially booked visit", async () => {
  await t.db.update(service).set({ currency: "EUR" });
  await t.db.update(service).set({ priceType: "hidden" }).where(eq(service.id, f.haircutId));
  await t.db.update(service).set({ priceType: "from" }).where(eq(service.id, f.colorId));
  const path = "/appointments/desktop-visits";
  const base = packet();
  const parts = await Promise.all(
    base.parts.map(async (part) => {
      const requirements = intakeRequirementsSchema.parse(
        await (
          await json(
            t.app,
            `/intake/requirements?serviceIds=${part.serviceIds.join(",")}&clientId=${f.clientId}`,
            "GET",
            undefined,
            owner.cookie,
          )
        ).json(),
      );
      const services = await getBookableServices(t.db, part.serviceIds);
      return {
        requirements,
        part: {
          ...part,
          id: crypto.randomUUID(),
          serviceQuotes: Object.fromEntries(services.map((s) => [s.id, s.quoteHash])),
          intakeReviewHash: requirements.reviewHash,
        },
      };
    }),
  );
  const input = {
    ...base,
    clientId: f.clientId,
    desktopGeneration: parts[0]?.requirements.desktopGeneration,
    parts: parts.map(({ part }) => part),
  };
  const preview = (body: unknown, who = owner) =>
    json(t.app, `${path}/preview`, "POST", body, who.cookie);
  const save = (body: unknown) => json(t.app, path, "POST", body, owner.cookie);
  expect((await preview(input, client)).status).toBe(403);
  expect((await preview({ ...input, desktopGeneration: "restored-history" })).status).toBe(409);
  const readReview = async (body: typeof input) => {
    const response = await preview(body);
    expect(response.status, await response.clone().text()).toBe(200);
    return desktopVisitPreviewSchema.parse(await response.json());
  };
  const first = await readReview(input);
  expect(first.parts.every((part) => part.available)).toBe(true);
  expect(first.parts.map((part) => part.priceStatus)).toEqual(["fixed", "from"]);
  expect(first.parts[1]?.startsAt).toBe(first.parts[0]?.endsAt);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect((await save({ ...input, reviewHash: "0".repeat(64) })).status).toBe(409);
  expect(
    (
      await json(
        t.app,
        "/appointments",
        "POST",
        {
          staffId: f.anaId,
          serviceIds: [f.colorId],
          startsAt: first.parts[1]?.startsAt,
          clientId: f.clientId,
        },
        owner.cookie,
      )
    ).status,
  ).toBe(201);
  const blocked = await save({ ...input, reviewHash: first.reviewHash });
  expect(blocked.status, await blocked.clone().text()).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "slot_taken" } });
  expect(await t.db.select().from(appointmentVisit)).toHaveLength(0);
  expect(await t.db.select().from(appointment)).toHaveLength(1);

  const next = { ...input, startsAt: "2026-03-16T12:00:00.000Z" };
  const second = await readReview(next);
  const request = { ...next, reviewHash: second.reviewHash };
  const committed = await save(request);
  expect(committed.status, await committed.clone().text()).toBe(201);
  const visit = visitSchema.parse(await committed.json());
  expect(visit.appointments.map((appointment) => appointment.id)).toEqual(
    input.parts.map((part) => part.id),
  );
  expect(visit.appointments.every((appointment) => appointment.itineraryId === visit.id)).toBe(
    true,
  );
  expect((await save(request)).status).toBe(201);
  expect(await t.db.select().from(appointmentVisit)).toHaveLength(1);
  expect(await t.db.select().from(appointment)).toHaveLength(3);

  // Model the exact older journal for the online guard, including when later
  // migrations ship. Restore the complete suffix before replaying this one data migration.
  const [head] = await t.db
    .select({ seq: sql<number>`max(${syncChange.seq})`.mapWith(Number) })
    .from(syncChange);
  const cursor = head?.seq ?? 0;
  const before = await t.db.select().from(appointment).orderBy(asc(appointment.id));
  const migration = readMigrationFiles({ migrationsFolder }).find(
    ({ folderMillis }) => folderMillis === 1795285620000,
  );
  if (!migration) throw new Error("Missing itinerary migration");
  const suffix = await t.db.execute<{ id: number; hash: string; timestamp: string }>(sql`
    delete from drizzle.__drizzle_migrations
    where created_at >= ${migration.folderMillis}
    returning id, hash, created_at::text as timestamp
  `);
  try {
    await expect(runMigrations(t.db, { online: true })).rejects.toThrow(
      "Migration 0107 requires a maintenance upgrade",
    );
  } finally {
    await t.db.transaction(async (tx) => {
      for (const row of suffix) {
        await tx.execute(sql`
          insert into drizzle.__drizzle_migrations (id, hash, created_at)
          values (${row.id}, ${row.hash}, ${row.timestamp}::bigint)
        `);
      }
    });
  }
  await t.db.transaction(async (tx) => {
    for (const statement of migration.sql) await tx.execute(sql.raw(statement));
  });
  const announced = await t.db
    .select({ id: syncChange.rowId })
    .from(syncChange)
    .where(gt(syncChange.seq, cursor));
  expect(announced.map(({ id }) => id).sort()).toEqual(input.parts.map((part) => part.id).sort());
  expect(await t.db.select().from(appointment).orderBy(asc(appointment.id))).toEqual(before);

  const policy = await json(
    t.app,
    "/admin/settings/booking-policy",
    "PUT",
    {
      enabled: true,
      depositKind: "fixed",
      depositValue: 500,
      holdMinutes: 15,
      cancellationWindowMinutes: 1440,
      lateCancellationBasisPoints: 2500,
      noShowBasisPoints: 5000,
      trustedExempt: true,
      version: 1,
    },
    owner.cookie,
  );
  expect(policy.status, await policy.clone().text()).toBe(200);
  const protectedVisit = {
    ...input,
    id: crypto.randomUUID(),
    startsAt: "2026-03-23T12:00:00.000Z",
    parts: input.parts.map((part) => ({ ...part, id: crypto.randomUUID() })),
  };
  const protectedPreview = await readReview(protectedVisit);
  expect(protectedPreview.parts.map((part) => part.depositWaiverRequired)).toEqual([true, true]);
  const blockedDeposit = await save({ ...protectedVisit, reviewHash: protectedPreview.reviewHash });
  expect(blockedDeposit.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(3);
});

test("availability resolves the hand-off and concurrent duplicate confirmations create one visit", async () => {
  const input = packet();
  const availability = await json(t.app, "/services/visit-availability", "POST", {
    date: "2026-03-09",
    parts: input.parts,
  });
  expect(availability.status).toBe(200);
  const { slots } = (await availability.json()) as {
    slots: { startsAt: string; parts: { startsAt: string; staffId: string }[] }[];
  };
  expect(slots.find((s) => s.startsAt === MONDAY_0900)?.parts.map((p) => p.staffId)).toEqual([
    f.beaId,
    f.anaId,
  ]);
  const responses = await Promise.all([
    json(t.app, "/appointments/visits", "POST", input, client.cookie),
    json(t.app, "/appointments/visits", "POST", input, client.cookie),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  expect(await responses[0]?.json()).toEqual(await responses[1]?.json());
  expect(await t.db.select().from(appointment)).toHaveLength(2);
});

test("visits cannot substitute another customer, repeat a service or cross ownership on replay", async () => {
  const body = packet();
  expect(
    (
      await json(
        t.app,
        "/appointments/visits",
        "POST",
        { ...body, clientId: f.clientId },
        client.cookie,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await json(
        t.app,
        "/appointments/visits",
        "POST",
        { ...body, parts: [body.parts[0], body.parts[0]] },
        client.cookie,
      )
    ).status,
  ).toBe(400);
  expect((await json(t.app, "/appointments/visits", "POST", body, client.cookie)).status).toBe(201);
  const stranger = await actor(t, "client", "other@example.com");
  expect((await json(t.app, "/appointments/visits", "POST", body, stranger.cookie)).status).toBe(
    409,
  );
  expect(
    (await json(t.app, `/appointments/visits/${body.id}`, "GET", undefined, stranger.cookie))
      .status,
  ).toBe(403);
});
