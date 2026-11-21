import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  errorResponseSchema,
  reportClientsSchema,
  reportOutcomesPageSchema,
  reportSummarySchema,
} from "@sob/contracts";
import { appointment, appointmentService, clientProfile, service, staffProfile } from "@sob/db";
import { eq, inArray } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "c@example.com"),
  ]);
  await seedReportFixture();
});

const call = (who: Actor | null, path: string) => json(t.app, path, "GET", undefined, who?.cookie);
const summary = async (who: Actor, query: string) => {
  const res = await call(who, `/admin/reports/summary?${query}`);
  expect(res.status).toBe(200);
  return reportSummarySchema.parse(await res.json());
};

type Svc = "haircut" | "color";
const PRICE = { haircut: 10000, color: 25000 } as const;

async function insert(
  who: "ana" | "bea",
  startsAt: string,
  status: "booked" | "completed" | "cancelled" | "no_show",
  services: Svc[],
  extra: { deletedAt?: Date } = {},
) {
  const start = new Date(startsAt);
  const [row] = await t.db
    .insert(appointment)
    .values({
      staffId: who === "ana" ? f.anaId : f.beaId,
      clientId: f.clientId,
      startsAt: start,
      endsAt: new Date(start.getTime() + 60 * 60_000),
      status,
      ...extra,
    })
    .returning();
  if (!row) throw new Error("insert failed");
  await t.db.insert(appointmentService).values(
    services.map((s, position) => ({
      appointmentId: row.id,
      serviceId: s === "haircut" ? f.haircutId : f.colorId,
      position,
      name: s === "haircut" ? "Haircut" : "Color",
      durationMinutes: 45,
      bufferMinutes: 15,
      priceCents: PRICE[s],
      currency: "ARS",
    })),
  );
  return row.id;
}

/**
 * Salon timezone is Buenos Aires (UTC-3). Reported window: 2026-03-09 .. 2026-03-11 (local).
 *
 *   in range
 *     A1 Ana  completed  haircut+color  03-09 09:00 local (12:00Z)           35000
 *     A2 Ana  completed  haircut        03-09 23:30 local (03-10 02:30Z)     10000  <- UTC date differs
 *     A3 Ana  no_show    haircut        03-10 12:00 local
 *     A4 Ana  cancelled  color          03-10 14:00 local
 *     B1 Bea  completed  haircut        03-10 00:30 local (03:30Z)           10000
 *     B2 Bea  booked     haircut        03-11 09:00 local
 *     E2 Bea  completed  haircut        03-11 23:30 local (03-12 02:30Z)     10000  <- UTC date differs
 *   out of range
 *     E1 Ana  completed  haircut        03-08 23:30 local (03-09 02:30Z)  (UTC date is inside!)
 *     D1 Ana  completed                 03-08, C1 Ana completed 03-12
 *     F1 Ana  completed, soft-deleted   03-10
 */
async function seedReportFixture() {
  await insert("ana", "2026-03-09T12:00:00Z", "completed", ["haircut", "color"]);
  await insert("ana", "2026-03-10T02:30:00Z", "completed", ["haircut"]);
  await insert("ana", "2026-03-10T15:00:00Z", "no_show", ["haircut"]);
  await insert("ana", "2026-03-10T17:00:00Z", "cancelled", ["color"]);
  await insert("bea", "2026-03-10T03:30:00Z", "completed", ["haircut"]);
  await insert("bea", "2026-03-11T12:00:00Z", "booked", ["haircut"]);
  await insert("bea", "2026-03-12T02:30:00Z", "completed", ["haircut"]);

  await insert("ana", "2026-03-09T02:30:00Z", "completed", ["haircut"]);
  await insert("ana", "2026-03-08T12:00:00Z", "completed", ["color"]);
  await insert("ana", "2026-03-12T12:00:00Z", "completed", ["color"]);
  await insert("ana", "2026-03-10T20:00:00Z", "completed", ["color"], { deletedAt: new Date() });
}

const RANGE = "from=2026-03-09&to=2026-03-11";

test("completed imported services contribute their reviewed price to every report breakdown", async () => {
  const appointmentId = await insert("ana", "2026-03-15T12:00:00Z", "completed", [
    "haircut",
    "color",
  ]);
  const services = await t.db
    .update(appointmentService)
    .set({ currency: "EUR" })
    .where(eq(appointmentService.appointmentId, appointmentId))
    .returning();
  const unknownLine = services.find((line) => line.serviceId === f.haircutId);
  if (!unknownLine) throw new Error("Missing fixture service");
  await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0 })
    .where(eq(appointmentService.id, unknownLine.id));

  const range = `from=2026-03-15&to=2026-03-15&currency=EUR&staffId=${f.anaId}`;
  const before = await summary(owner, range);
  expect(before).toMatchObject({
    totals: { revenueCents: PRICE.color, byStatus: { completed: 1 }, unpricedServices: 1 },
    series: [{ unpricedServices: 1 }],
    perStaff: [{ unpricedServices: 1 }],
    topServices: expect.arrayContaining([
      expect.objectContaining({
        serviceId: f.haircutId,
        count: 1,
        revenueCents: 0,
        unpricedServices: 1,
      }),
    ]),
  });
  const reviewedPrice = 3650;
  const review = await json(
    t.app,
    `/admin/commerce/appointments/${appointmentId}/imported-price`,
    "PUT",
    {
      appointmentVersion: 1,
      reference: "Reviewed source quote fixture",
      lines: [{ id: unknownLine.id, amountCents: reviewedPrice }],
    },
    owner.cookie,
  );
  expect(review.status, await review.clone().text()).toBe(200);

  const expectedRevenue = PRICE.color + reviewedPrice;
  const after = await summary(owner, range);
  expect(after.totals.unpricedServices).toBeUndefined();
  expect(after).toMatchObject({
    totals: { revenueCents: expectedRevenue, byStatus: { completed: 1 } },
    series: [{ date: "2026-03-15", revenueCents: expectedRevenue }],
    perStaff: [{ staffId: f.anaId, revenueCents: expectedRevenue }],
    topServices: expect.arrayContaining([
      expect.objectContaining({ serviceId: f.haircutId, count: 1, revenueCents: reviewedPrice }),
      expect.objectContaining({ serviceId: f.colorId, count: 1, revenueCents: PRICE.color }),
    ]),
  });
  expect(
    await t.db
      .select({
        sourcePrice: appointmentService.priceCents,
        reviewedPrice: appointmentService.reviewedPriceCents,
      })
      .from(appointmentService)
      .where(eq(appointmentService.id, unknownLine.id)),
  ).toEqual([{ sourcePrice: 0, reviewedPrice }]);
});

test("customer reports count each merged profile once and use completed salon history", async () => {
  const [newClient] = await t.db
    .insert(clientProfile)
    .values({ name: "New profile", tags: ["VIP", " ｖｉｐ ", "Other"] })
    .returning();
  const [alias] = await t.db.insert(clientProfile).values({ name: "Merged record" }).returning();
  const visitGroupId = crypto.randomUUID();
  await t.db
    .update(clientProfile)
    .set({ tags: ["vip"] })
    .where(eq(clientProfile.id, f.clientId));
  await t.db.insert(appointment).values([
    {
      clientId: alias!.id,
      staffId: f.anaId,
      status: "completed",
      visitGroupId,
      startsAt: new Date("2026-03-10T23:00:00Z"),
      endsAt: new Date("2026-03-11T00:00:00Z"),
    },
    {
      clientId: newClient!.id,
      staffId: f.beaId,
      status: "completed",
      visitGroupId,
      startsAt: new Date("2026-03-11T00:00:00Z"),
      endsAt: new Date("2026-03-11T01:00:00Z"),
    },
    {
      clientId: newClient!.id,
      staffId: f.beaId,
      status: "completed",
      startsAt: new Date("2026-03-11T15:00:00Z"),
      endsAt: new Date("2026-03-11T16:00:00Z"),
    },
    {
      clientId: newClient!.id,
      staffId: f.anaId,
      status: "no_show",
      startsAt: new Date("2026-03-08T15:00:00Z"),
      endsAt: new Date("2026-03-08T16:00:00Z"),
    },
  ]);
  const pair = { sourceId: alias!.id, targetId: newClient!.id };
  const preview = await json(t.app, "/admin/clients/merge/preview", "POST", pair, owner.cookie);
  expect(preview.status).toBe(200);
  const review = (await preview.json()) as { reviewHash: string };
  const merged = await json(
    t.app,
    "/admin/clients/merge",
    "POST",
    {
      ...pair,
      reviewHash: review.reviewHash,
      confirmedSamePerson: true,
      idempotencyKey: crypto.randomUUID(),
    },
    owner.cookie,
  );
  expect(merged.ok, await merged.text()).toBe(true);
  const path = `/admin/reports/clients?${RANGE}`;
  const response = await call(owner, path);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const result = reportClientsSchema.parse(await response.json());
  expect(result).toMatchObject({
    totals: { newClients: 1, returningClients: 1 },
    frequency: { one: 0, two: 1, threeOrMore: 1 },
    groups: [
      { name: "vip", clients: 2 },
      { name: "other", clients: 1 },
    ],
    rows: [
      { date: "2026-03-09", newClients: 0, returningClients: 1 },
      { date: "2026-03-10", newClients: 1, returningClients: 0 },
    ],
  });
  const bea = await call(owner, `${path}&staffId=${f.beaId}`);
  expect(reportClientsSchema.parse(await bea.json())).toMatchObject({
    totals: result.totals,
    frequency: { one: 0, two: 2, threeOrMore: 0 },
  });
  const anaOnly = await call(owner, `${path}&staffId=${f.anaId}`);
  expect(reportClientsSchema.parse(await anaOnly.json()).frequency).toEqual({
    one: 1,
    two: 1,
    threeOrMore: 0,
  });
  const empty = await call(owner, "/admin/reports/clients?from=2026-03-01&to=2026-03-01");
  expect(reportClientsSchema.parse(await empty.json()).frequency).toEqual({
    one: 0,
    two: 0,
    threeOrMore: 0,
  });
  expect((await call(ana, path)).status).toBe(403);
  expect((await call(client, path)).status).toBe(403);
  expect((await call(null, path)).status).toBe(401);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "receptionist" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await summary(ana, RANGE)).canReportClients).toBe(false);
  expect((await call(ana, path)).status).toBe(403);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, f.anaId));
  const manager = await call(ana, path);
  expect(reportClientsSchema.parse(await manager.json())).toEqual(result);
  expect((await summary(ana, RANGE)).canReportClients).toBe(true);
});

test("outcomes and CSV share the selected status, local date, professional and access rules", async () => {
  await t.db
    .update(clientProfile)
    .set({ name: '=HYPERLINK("a,b")' })
    .where(eq(clientProfile.id, f.clientId));
  const listUrl = "/admin/reports/outcomes";
  const exportUrl = `${listUrl}/export`;
  const query = `${RANGE}&status=cancelled&currency=ARS`;
  const response = await call(ana, `${listUrl}?${query}`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const list = reportOutcomesPageSchema.parse(await response.json());
  expect(list.total).toBe(1);
  expect(list.rows).toMatchObject([
    {
      client: '=HYPERLINK("a,b")',
      staff: "Ana",
      services: ["Color"],
      startsAt: "2026-03-10T17:00:00.000000Z",
    },
  ]);
  const exportResponse = await call(ana, `${exportUrl}?${query}&page=9`);
  expect(exportResponse.status).toBe(200);
  expect(exportResponse.headers.get("content-disposition")).toContain("appointments-cancelled");
  const csv = await exportResponse.text();
  expect(csv).toContain('"2026-03-10T14:00-03:00"');
  expect(csv).toContain(`"'=HYPERLINK(""a,b"")","Ana","Color"`);
  expect(csv).not.toContain('"no_show"');
  const noShows = await call(owner, `${exportUrl}?${RANGE}&status=no_show`);
  expect(noShows.headers.get("content-disposition")).toContain("appointments-no_show");
  expect(await noShows.text()).toContain('"no_show","2026-03-10T12:00-03:00"');
  expect((await call(ana, `${exportUrl}?${query}&staffId=${f.beaId}`)).status).toBe(403);
  expect((await call(client, `${listUrl}?${query}`)).status).toBe(403);
  expect((await call(null, `${exportUrl}?${query}`)).status).toBe(401);
  expect((await call(owner, `${exportUrl}?${RANGE}&status=completed`)).status).toBe(400);
});

describe("access control", () => {
  test("anonymous callers get 401, clients get 403", async () => {
    expect((await call(null, `/admin/reports/summary?${RANGE}`)).status).toBe(401);
    const res = await call(client, `/admin/reports/summary?${RANGE}`);
    expect(res.status).toBe(403);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("forbidden");
  });

  test("staff cannot ask for a colleague", async () => {
    const res = await call(ana, `/admin/reports/summary?${RANGE}&staffId=${f.beaId}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /admin/reports/summary as the owner", () => {
  test("breaks down local start hours, service, category and add-ons without double-counting visits", async () => {
    await t.db
      .update(service)
      .set({ category: "Hair" })
      .where(inArray(service.id, [f.haircutId, f.colorId]));
    const [extra] = await t.db
      .insert(service)
      .values({
        name: "Finish",
        catalogKind: "addon",
        category: "Extras",
        durationMinutes: 0,
        priceCents: 500,
      })
      .returning({ id: service.id });
    if (!extra) throw Error("Missing add-on");
    const [visit] = await t.db
      .insert(appointment)
      .values({
        staffId: f.anaId,
        clientId: f.clientId,
        startsAt: new Date("2026-03-11T23:00:00Z"),
        endsAt: new Date("2026-03-12T00:00:00Z"),
        status: "booked",
      })
      .returning({ id: appointment.id });
    if (!visit) throw Error("Missing visit");
    await t.db.insert(appointmentService).values(
      [
        { serviceId: f.haircutId, name: "Haircut" },
        { serviceId: extra.id, name: "Finish" },
        { serviceId: null, name: "Archived one" },
        { serviceId: null, name: "Archived two" },
      ].map((item, position) => ({
        ...item,
        position,
        appointmentId: visit.id,
        durationMinutes: 15,
        bufferMinutes: 0,
        priceCents: 500,
        currency: "ARS",
      })),
    );

    const breakdown = (await summary(owner, RANGE)).appointmentBreakdown;
    expect(breakdown?.hour.map(({ label, appointments }) => [label, appointments])).toEqual([
      ["00:00", 1],
      ["09:00", 2],
      ["12:00", 1],
      ["14:00", 1],
      ["20:00", 1],
      ["23:00", 2],
    ]);
    expect(breakdown?.category).toMatchObject([
      {
        label: "Hair",
        appointments: 8,
        byStatus: { completed: 4, cancelled: 1, no_show: 1, booked: 2 },
      },
      { label: null, appointments: 1 },
    ]);
    expect(breakdown?.service.map(({ label, appointments }) => [label, appointments])).toEqual([
      ["Haircut", 7],
      ["Color", 2],
      ["Archived one", 1],
      ["Archived two", 1],
    ]);
    expect(breakdown?.addon).toMatchObject([{ label: "Finish", appointments: 1 }]);
  });

  test("salon-wide numbers match the hand-computed fixture, bucketed in salon time", async () => {
    const s = await summary(owner, RANGE);
    expect(s).toMatchObject({
      from: "2026-03-09",
      to: "2026-03-11",
      timezone: "America/Argentina/Buenos_Aires",
      staffId: null,
    });
    expect(s.totals).toEqual({
      appointments: 7,
      byStatus: { booked: 1, completed: 4, cancelled: 1, no_show: 1 },
      revenueCents: 65000, // 35000 + 10000 + 10000 + 10000
      noShowRate: 0.2, // 1 / (4 completed + 1 no-show)
    });
    expect(s.series).toEqual([
      {
        date: "2026-03-09",
        appointments: 2,
        byStatus: { booked: 0, completed: 2, cancelled: 0, no_show: 0 },
        revenueCents: 45000,
      },
      {
        date: "2026-03-10",
        appointments: 3,
        byStatus: { booked: 0, completed: 1, cancelled: 1, no_show: 1 },
        revenueCents: 10000,
      },
      {
        date: "2026-03-11",
        appointments: 2,
        byStatus: { booked: 1, completed: 1, cancelled: 0, no_show: 0 },
        revenueCents: 10000,
      },
    ]);
    expect(s.topServices).toEqual([
      { serviceId: f.haircutId, name: "Haircut", count: 4, revenueCents: 40000 },
      { serviceId: f.colorId, name: "Color", count: 1, revenueCents: 25000 },
    ]);
    expect(s.perStaff).toEqual([
      {
        staffId: f.anaId,
        displayName: "Ana",
        appointments: 4,
        byStatus: { booked: 0, completed: 2, cancelled: 1, no_show: 1 },
        revenueCents: 45000,
        noShowRate: 0.3333,
      },
      {
        staffId: f.beaId,
        displayName: "Bea",
        appointments: 3,
        byStatus: { booked: 1, completed: 2, cancelled: 0, no_show: 0 },
        revenueCents: 20000,
        noShowRate: 0,
      },
    ]);
  });

  test("the window edges are salon-local: 23:30 on the last day counts, 23:30 the day before does not", async () => {
    const lastDay = await summary(owner, "from=2026-03-11&to=2026-03-11");
    expect(lastDay.totals.appointments).toBe(2); // B2 + E2
    const dayBefore = await summary(owner, "from=2026-03-08&to=2026-03-08");
    expect(dayBefore.totals.appointments).toBe(2); // D1 + E1 (23:30 local on 03-08)
  });

  test("staffId narrows every section to that staff member", async () => {
    const s = await summary(owner, `${RANGE}&staffId=${f.beaId}`);
    expect(s.staffId).toBe(f.beaId);
    expect(s.totals).toEqual({
      appointments: 3,
      byStatus: { booked: 1, completed: 2, cancelled: 0, no_show: 0 },
      revenueCents: 20000,
      noShowRate: 0,
    });
    expect(s.topServices).toEqual([
      { serviceId: f.haircutId, name: "Haircut", count: 2, revenueCents: 20000 },
    ]);
    expect(s.perStaff.map((p) => p.staffId)).toEqual([f.beaId]);
  });

  test("an empty window returns a zero-filled series", async () => {
    const s = await summary(owner, "from=2026-05-01&to=2026-05-03");
    expect(s.series.map((d) => d.date)).toEqual(["2026-05-01", "2026-05-02", "2026-05-03"]);
    expect(s.totals).toEqual({
      appointments: 0,
      byStatus: { booked: 0, completed: 0, cancelled: 0, no_show: 0 },
      revenueCents: 0,
      noShowRate: null,
    });
    expect(s.topServices).toEqual([]);
  });

  test("invalid ranges are 400 validation_error", async () => {
    for (const q of [
      "from=2026-03-11&to=2026-03-09",
      "from=2026-03-09",
      "from=2026-03-09T00:00:00Z&to=2026-03-10",
      "from=2024-01-01&to=2026-03-10",
      `${RANGE}&staffId=nope`,
    ]) {
      const res = await call(owner, `/admin/reports/summary?${q}`);
      expect([q, res.status]).toEqual([q, 400]);
      expect(errorResponseSchema.parse(await res.json()).error.code).toBe("validation_error");
    }
  });

  test("an unknown staffId yields 404", async () => {
    const res = await call(owner, `/admin/reports/summary?${RANGE}&staffId=${Bun.randomUUIDv7()}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/reports/summary as staff", () => {
  test("staff get only their own numbers, without naming themselves", async () => {
    const s = await summary(ana, RANGE);
    expect(s.staffId).toBe(f.anaId);
    expect(s.totals).toEqual({
      appointments: 4,
      byStatus: { booked: 0, completed: 2, cancelled: 1, no_show: 1 },
      revenueCents: 45000,
      noShowRate: 0.3333,
    });
    expect(s.topServices).toEqual([
      { serviceId: f.haircutId, name: "Haircut", count: 2, revenueCents: 20000 },
      { serviceId: f.colorId, name: "Color", count: 1, revenueCents: 25000 },
    ]);
    expect(s.perStaff.map((p) => p.displayName)).toEqual(["Ana"]);
    expect(s.appointmentBreakdown?.hour.map((row) => row.label)).toEqual([
      "09:00",
      "12:00",
      "14:00",
      "23:00",
    ]);
  });

  test("naming themselves explicitly is fine", async () => {
    const s = await summary(ana, `${RANGE}&staffId=${f.anaId}`);
    expect(s.totals.appointments).toBe(4);
  });
});

test("report revenue separates currencies and advertises the available choices", async () => {
  const [visit] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: f.clientId,
      startsAt: new Date("2026-03-10T18:00:00Z"),
      endsAt: new Date("2026-03-10T19:00:00Z"),
      status: "completed",
    })
    .returning();
  if (!visit) throw Error("Missing fixture visit");
  await t.db.insert(appointmentService).values({
    appointmentId: visit.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 2500,
    currency: "EUR",
  });
  const eur = await summary(owner, `${RANGE}&currency=EUR`);
  expect(eur.currency).toBe("EUR");
  expect(eur.currencies).toEqual(["ARS", "EUR"]);
  expect(eur.totals).toMatchObject({ appointments: 1, revenueCents: 2500 });
  expect(eur.appointmentBreakdown?.hour).toMatchObject([{ label: "15:00", appointments: 1 }]);
  const ars = await summary(owner, `${RANGE}&currency=ARS`);
  expect(ars.totals.revenueCents).toBeGreaterThan(2500);
  expect(ars.currency).toBe("ARS");
  expect((await summary(owner, RANGE)).currency).toBe("EUR");
});
