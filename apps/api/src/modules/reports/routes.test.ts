import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { errorResponseSchema, reportSummarySchema } from "@sob/contracts";
import { appointment, appointmentService } from "@sob/db";
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
  });

  test("naming themselves explicitly is fine", async () => {
    const s = await summary(ana, `${RANGE}&staffId=${f.anaId}`);
    expect(s.totals.appointments).toBe(4);
  });
});
