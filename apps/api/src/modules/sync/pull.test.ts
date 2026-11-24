import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { calendarResponseSchema } from "@sob/contracts";
import {
  appointmentContext,
  appointmentService,
  clientProfile,
  resourcePool,
  resourceReservation,
  service,
  serviceResource,
  staffProfile,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { errorCodeOf, pull, pullAll } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let bea: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "sync" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, bea, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

const call = (who: Actor | null, method: string, path: string, body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);

async function head() {
  return (await pull(t, owner, { since: 0, limit: 1 })).headSeq;
}

async function book(staffId = f.anaId, startsAt = MONDAY_0900) {
  const res = await call(owner, "POST", "/appointments", {
    staffId,
    serviceIds: [f.haircutId],
    startsAt,
    clientId: f.clientId,
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; version: number };
}

test("client group projection uses Cloud normalization and respects directory visibility", async () => {
  const cursor = await head();
  const reason = "Private reason absent from the group projection";
  await t.db
    .update(clientProfile)
    .set({ tags: ["  ＶＩＰ  ", "VIP", ""], bookingAccessReason: reason })
    .where(eq(clientProfile.id, f.clientId));
  const clientChange = (page: Awaited<ReturnType<typeof pull>>) =>
    page.changes.find((change) => change.entity === "client" && change.id === f.clientId);
  const standardPage = await pull(t, owner, { since: cursor });
  expect(standardPage.clientGroups).toBeUndefined();
  const standard = clientChange(standardPage);
  expect(standard?.op).toBe("upsert");
  expect(standard?.data).not.toHaveProperty("groupNames");
  for (const who of [owner, ana]) {
    const page = await pull(t, who, { since: cursor, clientGroups: "1" });
    expect(page.clientGroups).toBe(true);
    const projected = clientChange(page);
    expect(projected?.data).toMatchObject({ groupNames: ["vip"] });
    const raw = await call(who, "GET", `/sync/pull?since=${cursor}&clientGroups=1`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("cache-control")).toBe("private, no-store");
    const body = (await raw.json()) as Awaited<ReturnType<typeof pull>>;
    const rawClient = clientChange(body);
    expect(rawClient?.data).toMatchObject({ groupNames: ["vip"] });
    expect(rawClient?.data).not.toHaveProperty("tags");
    expect(rawClient?.data).not.toHaveProperty("bookingAccess");
    expect(rawClient?.data).not.toHaveProperty("bookingAccessReason");
    expect(JSON.stringify(rawClient)).not.toContain(reason);
  }
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  const restricted = await pull(t, ana, { since: cursor, clientGroups: "1" });
  expect(restricted.clientGroups).toBeUndefined();
  const hidden = clientChange(restricted);
  expect(hidden).toMatchObject({ op: "delete", data: null });
});

test("staff can repair service colors at the head without replaying the log", async () => {
  await t.db
    .update(service)
    .set({ color: "#AC3456", active: false })
    .where(eq(service.id, f.haircutId));
  const cursor = await head();
  expect(await pull(t, ana, { since: cursor, catalogColors: "1" })).toMatchObject({
    changes: [],
    nextCursor: cursor,
    hasMore: false,
    catalogColors: { [f.haircutId]: "#AC3456" },
  });
  expect((await pull(t, ana, { since: cursor })).catalogColors).toBeUndefined();
  const unauthorized = await call(client, "GET", `/sync/pull?since=${cursor}&catalogColors=1`);
  expect(unauthorized.status).toBe(403);
});

test("an existing replica learns Booksy origin without an appointment edit", async () => {
  const imported = await book();
  const native = await book(f.beaId);
  await t.db.insert(appointmentContext).values({
    appointmentId: imported.id,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "private-source-reference",
  });
  const cursor = await head();
  const migration = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0058_sync_booksy_appointment_origin.sql",
      import.meta.url,
    ),
  ).text();
  await t.db.transaction(async (tx) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      await tx.execute(sql.raw(statement.trim()));
    }
  });
  const page = await pull(t, owner, { since: cursor });
  expect(page.changes).toMatchObject([
    {
      id: imported.id,
      op: "upsert",
      data: { importedFromBooksy: true, version: imported.version },
    },
  ]);
  expect(page.changes.some(({ id }) => id === native.id)).toBe(false);
  expect(JSON.stringify(page)).not.toContain("private-source-reference");
  expect((await pull(t, bea, { since: cursor })).changes).toMatchObject([
    { id: imported.id, op: "delete", data: null },
  ]);
});

test("reception receives resource calendar refresh markers without the management catalogue", async () => {
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "receptionist" })
    .where(eq(staffProfile.id, f.anaId));
  const since = await head();
  const created = await call(owner, "POST", "/admin/resources", {
    name: "New room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const query = { since, resourceCatalogue: "1" as const, resourcePools: "delta" as const };
  const reception = await pull(t, ana, query);
  expect(reception.refresh).toContain("resource_catalogue");
  expect(reception.resourcePools).toBeUndefined();
  expect((await pull(t, bea, query)).refresh ?? []).not.toContain("resource_catalogue");
  expect((await pull(t, ana, { since })).refresh ?? []).not.toContain("resource_catalogue");
});

test("existing replicas receive confirmed resource quantities only for visible appointments", async () => {
  const unallocated = await book(f.beaId);
  const [room] = await t.db
    .insert(resourcePool)
    .values({
      name: "Treatment room",
      kind: "room",
      capacity: 2,
      idempotencyKey: "fixture-room",
      requestHash: "fixture-room",
    })
    .returning();
  if (!room) throw new Error("Missing resource pool");
  await t.db
    .insert(serviceResource)
    .values({ serviceId: f.haircutId, resourceId: room.id, quantity: 2 });
  const allocated = await book();
  const cursor = await head();
  const migration = await Bun.file(
    new URL("../../../../../packages/db/drizzle/0124_sync_booked_resources.sql", import.meta.url),
  ).text();
  await t.db.transaction(async (tx) => {
    // The fixture already installed the change trigger. Replay only the historical backfill.
    for (const statement of migration.split("--> statement-breakpoint").slice(-2)) {
      await tx.execute(sql.raw(statement.trim()));
    }
  });
  for (const viewer of [owner, ana]) {
    const page = await pull(t, viewer, { since: cursor });
    expect(page.changes).toHaveLength(1);
    expect(page.changes[0]).toMatchObject({
      id: allocated.id,
      entity: "appointment",
      op: "upsert",
      data: {
        resources: [{ resourceId: room.id, name: "Treatment room", quantity: 2 }],
        version: allocated.version,
      },
    });
  }
  expect((await pull(t, bea, { since: cursor })).changes).toMatchObject([
    { id: allocated.id, op: "delete", data: null },
  ]);
  const full = await pullAll(t, owner);
  const unrelated = full.changes.find((change) => change.id === unallocated.id);
  expect(unrelated?.op).toBe("upsert");
  expect(unrelated?.data).not.toHaveProperty("resources");

  const beforeRename = await head();
  const renamed = await call(owner, "PUT", `/admin/resources/${room.id}`, {
    name: "Room 2",
    kind: "room",
    capacity: 2,
    active: true,
    version: room.version,
  });
  expect(renamed.status).toBe(200);
  const updated = (await pull(t, ana, { since: beforeRename })).changes.find(
    (change) => change.id === allocated.id,
  );
  expect(updated).toMatchObject({ data: { version: allocated.version } });
  expect(updated?.data).toHaveProperty("resources", [
    { resourceId: room.id, name: "Room 2", quantity: 2 },
  ]);

  const beforeRemoval = await head();
  await t.db.delete(resourceReservation).where(eq(resourceReservation.appointmentId, allocated.id));
  const cleared = (await pull(t, ana, { since: beforeRemoval })).changes.find(
    (change) => change.id === allocated.id,
  );
  expect(cleared).toMatchObject({ op: "upsert", data: { version: allocated.version } });
  expect(cleared?.data).not.toHaveProperty("resources");
});

test("billing holds and verified prices replicate without exposing the evidence reference or notes", async () => {
  const pending = await book();
  const legacy = await book(f.beaId);
  const [line] = await t.db
    .update(appointmentService)
    .set({ currency: "EUR", priceCents: 0, sourceUnpriced: true })
    .where(eq(appointmentService.appointmentId, pending.id))
    .returning();
  await t.db.insert(appointmentContext).values({
    appointmentId: legacy.id,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "legacy-proof",
    requestedStaffId: f.beaId,
    paid: true,
    invoiced: true,
    internalNote: "Fixture financial annotation",
    customerComment: "Fixture private customer comment",
  });
  const initial = await pullAll(t, owner);
  expect(initial.changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: pending.id,
        data: expect.objectContaining({
          billingReviewReasons: ["unknown_amount"],
          services: [expect.objectContaining({ sourceUnpriced: true, priceCents: 0 })],
        }),
      }),
      expect.objectContaining({
        id: legacy.id,
        data: expect.objectContaining({
          billingReviewReasons: ["paid_in_booksy", "invoiced_in_booksy"],
          serviceBadges: [
            {
              servicePosition: 0,
              billingSource: "booksy",
              requested: true,
              invoiced: true,
              paid: true,
              internalNote: true,
              customerComment: true,
            },
          ],
        }),
      }),
    ]),
  );
  expect(JSON.stringify(initial)).not.toContain("Fixture financial annotation");
  expect(JSON.stringify(initial)).not.toContain("Fixture private customer comment");
  expect((await pullAll(t, ana)).changes.find((row) => row.id === legacy.id)).toMatchObject({
    op: "delete",
    data: null,
  });

  const migration = await Bun.file(
    new URL(
      "../../../../../packages/db/drizzle/0057_sync_import_billing_holds.sql",
      import.meta.url,
    ),
  ).text();
  await t.db.transaction(async (tx) => {
    for (const statement of migration.split("--> statement-breakpoint")) {
      await tx.execute(sql.raw(statement.trim()));
    }
  });
  const backfill = await pull(t, owner, { since: initial.cursor });
  expect(backfill.changes.map(({ id }) => id).sort()).toEqual([pending.id, legacy.id].sort());

  const saved = await call(
    owner,
    "PUT",
    `/admin/commerce/appointments/${pending.id}/imported-price`,
    {
      appointmentVersion: pending.version,
      lines: [{ id: line!.id, amountCents: 3650 }],
      reference: "Private fixture evidence",
    },
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  const page = await pull(t, owner, { since: backfill.nextCursor });
  const updated = page.changes.find((row) => row.entity === "appointment" && row.id === pending.id);
  expect(updated?.data).toMatchObject({
    version: pending.version + 1,
    services: [{ priceCents: 3650 }],
  });
  expect(updated?.data).not.toHaveProperty("billingReviewReasons");
  expect(JSON.stringify(page)).not.toContain("Private fixture evidence");
});

test("restricted staff receive visible calendar badges without billing data or note text", async () => {
  const own = await book();
  const colleague = await book(f.beaId);
  await book(f.anaId, new Date(Date.parse(MONDAY_0900) + 2 * 60 * 60_000).toISOString());
  const sourceOnly = await book(
    f.anaId,
    new Date(Date.parse(MONDAY_0900) + 3 * 60 * 60_000).toISOString(),
  );
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  await t.db.insert(appointmentContext).values(
    [own, colleague].map((visit, index) => ({
      appointmentId: visit.id,
      servicePosition: 0,
      source: "booksy",
      sourceRef: `fixture-proof-${index}`,
      requestedStaffId: index === 0 ? f.anaId : f.beaId,
      internalNote: "Private fixture note",
      customerComment: "Private fixture comment",
      paid: true,
      invoiced: true,
    })),
  );
  await t.db.insert(appointmentContext).values({
    appointmentId: sourceOnly.id,
    servicePosition: 0,
    source: "booksy",
    sourceRef: "fixture-proof-source-only",
  });

  const page = await pullAll(t, ana);
  const row = page.changes.find(
    (change) => change.entity === "appointment" && change.op === "upsert" && change.id === own.id,
  );
  const visibleContext = {
    importedFromBooksy: true,
    serviceBadges: [
      {
        servicePosition: 0,
        requested: true,
        internalNote: true,
        customerComment: true,
        paid: false,
        invoiced: false,
        billingSource: null,
      },
    ],
  };
  expect(row).toMatchObject({ op: "upsert", data: visibleContext });
  expect(row?.data).not.toHaveProperty("billingReviewReasons");
  expect(row?.data).not.toHaveProperty("externalBalance");
  expect(row?.data).not.toHaveProperty("externallySettled");
  expect(JSON.stringify(page)).not.toContain("Private fixture");
  expect(JSON.stringify(page)).not.toContain("fixture-proof");
  expect(page.changes.find(({ id }) => id === colleague.id)).toMatchObject({
    op: "delete",
    data: null,
  });

  const range = new URLSearchParams({
    from: MONDAY_0900,
    to: new Date(Date.parse(MONDAY_0900) + 4 * 60 * 60_000).toISOString(),
  });
  const calendar = await call(ana, "GET", `/appointments/calendar?${range}`);
  expect(calendar.status).toBe(200);
  const agenda = calendarResponseSchema.parse(await calendar.json());
  const visibleVisit = agenda.appointments.find((visit) => visit.id === own.id);
  expect(visibleVisit).toMatchObject(visibleContext);
  expect(visibleVisit?.billingReviewReasons).toBeUndefined();
  expect(visibleVisit?.externalBalance).toBeUndefined();
  expect(agenda.appointments.some((visit) => visit.id === colleague.id)).toBe(false);
  expect(JSON.stringify(agenda)).not.toContain("Private fixture");
  const context = await call(ana, "GET", `/appointments/${own.id}/context`);
  expect(context.status).toBe(200);
  expect(await context.json()).toMatchObject({
    canEdit: false,
    rows: [{ internalNote: "Private fixture note", invoiced: null, paid: null }],
  });

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
  const catchUp = await pull(t, ana, { since: page.cursor });
  expect(catchUp.changes.map(({ id }) => id).sort()).toEqual(
    [own.id, colleague.id, sourceOnly.id].sort(),
  );
  expect(catchUp.changes.find(({ id }) => id === own.id)?.data).toEqual(row?.data);
  const reannounced = catchUp.changes.find(({ id }) => id === sourceOnly.id);
  expect(reannounced?.data).toMatchObject({ importedFromBooksy: true });
  expect(reannounced?.data).not.toHaveProperty("serviceBadges");
});

describe("authorization", () => {
  test("anonymous callers get 401", async () => {
    const res = await call(null, "GET", "/sync/pull");
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("unauthorized");
  });

  test("the client role is forbidden", async () => {
    const res = await call(client, "GET", "/sync/pull");
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("forbidden");
  });
  test("contact and calendar visibility follow access changes even at the log head", async () => {
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "receptionist" })
      .where(eq(staffProfile.id, f.anaId));
    expect(await pull(t, ana, { since: await head() })).toMatchObject({
      changes: [],
      clientDirectory: true,
      calendarScope: "all",
      viewerEditCalendar: true,
      viewerRole: "staff",
    });
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "restricted" })
      .where(eq(staffProfile.id, f.anaId));
    expect(await pull(t, ana, { since: await head() })).toMatchObject({
      changes: [],
      clientDirectory: false,
      calendarScope: f.anaId,
      viewerEditCalendar: false,
    });
  });

  test("time off scope follows the caller's current preset even on an empty pull", async () => {
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "manager" })
      .where(eq(staffProfile.id, f.anaId));
    let h = await head();
    expect((await pull(t, ana, { since: h })).timeOffScope).toBe("all");
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "restricted" })
      .where(eq(staffProfile.id, f.anaId));
    h = await head();
    const page = await pull(t, ana, { since: h });
    expect(page.changes).toEqual([]);
    expect(page.timeOffScope).toBe("none");
  });
});

describe("snapshot (since=0)", () => {
  test("returns every synced row once, validated against the contract", async () => {
    const { changes } = await pullAll(t, owner);
    const keys = changes.map((c) => `${c.entity}:${c.id}`);
    expect(new Set(keys).size).toBe(keys.length);
    const entities = new Set(changes.map((c) => c.entity));
    for (const entity of [
      "client",
      "service",
      "staff",
      "service_staff",
      "working_hours",
      "salon_settings",
    ]) {
      expect(entities.has(entity as never), entity).toBe(true);
    }
    expect(changes.find((c) => c.entity === "salon_settings")?.id).toBe("1");
    expect(changes.every((c) => c.op === "upsert" || c.data === null)).toBe(true);
  });

  test("an empty pull at the head returns the same cursor and no more pages", async () => {
    const { headSeq: h, giftCardsScope } = await pull(t, owner, { since: 0, limit: 1 });
    expect(giftCardsScope).toMatch(/^[a-f0-9]{64}$/);
    const page = await pull(t, owner, { since: h });
    expect(page).toEqual({
      generation: "initial",
      giftCardsScope,
      bookedResourceIds: true,
      appointmentDepositStatus: true,
      changes: [],
      nextCursor: h,
      hasMore: false,
      headSeq: h,
      timeOffScope: "all",
      clientDirectory: true,
      calendarScope: "all",
      viewerRole: "owner",
      viewerEditCatalogue: true,
      viewerEditCalendar: true,
    });
  });

  test("a cursor ahead of the server is refused so the client can resync", async () => {
    const h = await head();
    const res = await call(owner, "GET", `/sync/pull?since=${h + 1000}`);
    expect(res.status).toBe(409);
    expect(await errorCodeOf(res)).toBe("invalid_state");
  });

  test("validates query bounds", async () => {
    expect((await call(owner, "GET", "/sync/pull?limit=0")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?limit=100000")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?since=-1")).status).toBe(400);
    expect((await call(owner, "GET", "/sync/pull?since=abc")).status).toBe(400);
  });
});

describe("REST writes show up in pull", () => {
  test("booking and cancelling an appointment", async () => {
    const cursor = await head();
    const appt = await book();
    const created = await pull(t, owner, { since: cursor });
    expect(created.changes).toHaveLength(1);
    const change = created.changes[0];
    expect(change).toMatchObject({ entity: "appointment", id: appt.id, op: "upsert" });
    if (change?.entity !== "appointment" || change.op !== "upsert") throw new Error("unexpected");
    expect(change.data.status).toBe("booked");
    expect(change.data.services).toHaveLength(1);

    const cancelled = await call(owner, "PATCH", `/appointments/${appt.id}`, {
      version: appt.version,
      status: "cancelled",
    });
    expect(cancelled.status).toBe(200);
    const after = await pull(t, owner, { since: created.nextCursor });
    expect(after.changes).toHaveLength(1);
    const next = after.changes[0];
    if (next?.entity !== "appointment" || next.op !== "upsert") throw new Error("unexpected");
    expect(next.data.status).toBe("cancelled");
    expect(next.data.version).toBe(2);
  });

  test("a soft-deleted client is a tombstone", async () => {
    const [extra] = await t.db.insert(clientProfile).values({ name: "Temp" }).returning();
    if (!extra) throw new Error("insert failed");
    const cursor = await head();
    const res = await call(owner, "DELETE", `/admin/clients/${extra.id}`);
    expect(res.status).toBe(200);
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes).toEqual([
      { seq: expect.any(Number), entity: "client", id: extra.id, op: "delete", data: null },
    ]);
  });

  test("time off create then delete: upsert, then tombstone", async () => {
    const cursor = await head();
    const created = await call(owner, "POST", `/admin/staff/${f.anaId}/time-off`, {
      startsAt: "2026-03-12T12:00:00.000Z",
      endsAt: "2026-03-12T14:00:00.000Z",
    });
    expect(created.status).toBe(201);
    const { timeOff } = (await created.json()) as { timeOff: { id: string } };
    const first = await pull(t, owner, { since: cursor });
    expect(first.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
      ["time_off", timeOff.id, "upsert"],
    ]);

    await call(owner, "DELETE", `/admin/staff/${f.anaId}/time-off/${timeOff.id}`);
    const second = await pull(t, owner, { since: first.nextCursor });
    expect(second.changes.map((c) => [c.entity, c.id, c.op])).toEqual([
      ["time_off", timeOff.id, "delete"],
    ]);
  });

  test("replacing working hours tombstones the old rows and announces the new ones", async () => {
    const cursor = await head();
    const res = await call(owner, "PUT", `/admin/staff/${f.anaId}/working-hours`, {
      hours: [{ weekday: 2, startTime: "10:00", endTime: "16:00" }],
    });
    expect(res.status).toBe(200);
    const page = await pull(t, owner, { since: cursor });
    const ops = page.changes
      .filter((c) => c.entity === "working_hours")
      .map((c) => c.op)
      .sort();
    expect(ops).toEqual(["delete", "upsert"]);
  });

  test("salon settings edits", async () => {
    const cursor = await head();
    await call(owner, "PATCH", "/admin/settings", { minNoticeMinutes: 15 });
    const page = await pull(t, owner, { since: cursor });
    const change = page.changes[0];
    expect(change?.entity).toBe("salon_settings");
    if (change?.entity !== "salon_settings" || change.op !== "upsert")
      throw new Error("unexpected");
    expect(change.data.minNoticeMinutes).toBe(15);
  });
});

describe("pagination and cursors", () => {
  test("pages are bounded, cursors never decrease and the union equals the full pull", async () => {
    for (let i = 0; i < 9; i++) await t.db.insert(clientProfile).values({ name: `Client ${i}` });
    const full = await pull(t, owner, { since: 0, limit: 500 });
    expect(full.hasMore).toBe(false);

    let cursor = 0;
    const seen: string[] = [];
    let pages = 0;
    for (;;) {
      const page = await pull(t, owner, { since: cursor, limit: 4 });
      pages++;
      expect(page.changes.length).toBeLessThanOrEqual(4);
      expect(page.nextCursor).toBeGreaterThanOrEqual(cursor);
      for (const c of page.changes) expect(c.seq).toBeLessThanOrEqual(page.nextCursor);
      seen.push(...page.changes.map((c) => `${c.entity}:${c.id}`));
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }
    expect(pages).toBeGreaterThan(2);
    expect(cursor).toBe(full.nextCursor);
    expect(new Set(seen)).toEqual(new Set(full.changes.map((c) => `${c.entity}:${c.id}`)));
  });

  test("several writes to one row inside a page collapse into its latest entry", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "Edit me" }).returning();
    if (!row) throw new Error("insert failed");
    const cursor = await head();
    for (const name of ["one", "two", "three"]) {
      await t.db.update(clientProfile).set({ name }).where(eq(clientProfile.id, row.id));
    }
    const page = await pull(t, owner, { since: cursor });
    expect(page.changes).toHaveLength(1);
    const change = page.changes[0];
    if (change?.entity !== "client" || change.op !== "upsert") throw new Error("unexpected");
    expect(change.data.name).toBe("three");
    expect(page.nextCursor).toBe(page.headSeq);
  });
});

describe("role filtering", () => {
  test("staff see their own appointments; other calendars arrive as tombstones", async () => {
    const mine = await book(f.anaId);
    const theirs = await book(f.beaId);
    const { changes } = await pullAll(t, ana);
    const appt = (id: string) => changes.find((c) => c.entity === "appointment" && c.id === id);
    expect(appt(mine.id)?.op).toBe("upsert");
    expect(appt(theirs.id)).toMatchObject({ op: "delete", data: null });
  });

  test("staff do not receive other calendars' schedules or login links", async () => {
    expect((await pull(t, ana, { since: 0 })).timeOffScope).toBe(f.anaId);
    await call(owner, "POST", `/admin/staff/${f.beaId}/time-off`, {
      startsAt: "2026-03-12T12:00:00.000Z",
      endsAt: "2026-03-12T14:00:00.000Z",
    });
    const asAna = await pullAll(t, ana);
    const hours = asAna.changes.filter((c) => c.entity === "working_hours");
    for (const c of hours) {
      if (c.op === "upsert" && c.entity === "working_hours") expect(c.data.staffId).toBe(f.anaId);
    }
    expect(hours.some((c) => c.op === "delete")).toBe(true);
    expect(asAna.changes.find((c) => c.entity === "time_off")?.op).toBe("delete");

    const staffRows = asAna.changes.filter((c) => c.entity === "staff" && c.op === "upsert");
    for (const c of staffRows) {
      if (c.entity === "staff" && c.op === "upsert") expect(c.data.userId).toBeNull();
    }
    const asOwner = await pullAll(t, owner);
    const ownerStaff = asOwner.changes.find((c) => c.entity === "staff" && c.id === f.anaId);
    if (ownerStaff?.entity !== "staff" || ownerStaff.op !== "upsert") throw new Error("unexpected");
    expect(ownerStaff.data.userId).toBe(ana.userId);
  });

  test("an appointment moved to another calendar disappears for the old owner", async () => {
    const appt = await book(f.anaId);
    const cursor = (await pullAll(t, ana)).cursor;
    const moved = await call(owner, "PATCH", `/appointments/${appt.id}`, {
      version: appt.version,
      staffId: f.beaId,
    });
    expect(moved.status).toBe(200);
    const asAna = await pull(t, ana, { since: cursor });
    expect(asAna.changes).toEqual([
      { seq: expect.any(Number), entity: "appointment", id: appt.id, op: "delete", data: null },
    ]);
    const asBea = await pullAll(t, bea);
    expect(asBea.changes.find((c) => c.id === appt.id)?.op).toBe("upsert");
  });
});

test("fixtures stay referenced (guards the seeded staff profile link)", async () => {
  const [row] = await t.db.select().from(staffProfile).where(eq(staffProfile.id, f.anaId));
  expect(row?.userId).toBe(ana.userId);
});
