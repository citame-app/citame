import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  appointmentSchema,
  errorResponseSchema,
  listAppointmentsResponseSchema,
} from "@sob/contracts";
import { appointment } from "@sob/db";
import { eq } from "drizzle-orm";
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
let clientA: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, clientA] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "a@example.com"),
  ]);
});

const RANGE = "from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
const list = async (who: Actor, query = "") => {
  const res = await json(t.app, `/appointments?${RANGE}${query}`, "GET", undefined, who.cookie);
  expect(res.status).toBe(200);
  return listAppointmentsResponseSchema.parse(await res.json());
};

/** Five Ana bookings on Monday 09:00, 10:00, 11:00, 12:00, 13:00 local (12:00Z + n h). */
async function bookFive() {
  const created = [];
  for (let i = 0; i < 5; i++) {
    const res = await json(
      t.app,
      "/appointments",
      "POST",
      {
        staffId: f.anaId,
        serviceIds: [f.haircutId],
        startsAt: new Date(Date.parse("2026-03-09T12:00:00Z") + i * 3_600_000).toISOString(),
        clientId: f.clientId,
      },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    created.push(appointmentSchema.parse(await res.json()));
  }
  return created;
}

describe("paging", () => {
  test("without paging parameters everything (up to the default page size) comes back with an envelope", async () => {
    const created = await bookFive();
    const body = await list(owner);
    expect(body).toMatchObject({ page: 1, pageSize: 50, total: 5 });
    expect(body.appointments.map((a) => a.id)).toEqual(created.map((a) => a.id));
  });

  test("pages are consecutive slices of the same ordering and total is constant", async () => {
    const created = await bookFive();
    const p1 = await list(owner, "&pageSize=2&page=1");
    const p2 = await list(owner, "&pageSize=2&page=2");
    const p3 = await list(owner, "&pageSize=2&page=3");
    const p4 = await list(owner, "&pageSize=2&page=4");
    expect([p1, p2, p3, p4].map((p) => p.appointments.length)).toEqual([2, 2, 1, 0]);
    expect([p1, p2, p3].flatMap((p) => p.appointments.map((a) => a.id))).toEqual(
      created.map((a) => a.id),
    );
    expect([p1, p2, p3, p4].map((p) => p.total)).toEqual([5, 5, 5, 5]);
    expect(p2).toMatchObject({ page: 2, pageSize: 2 });
  });

  test("snapshots are attached to the right appointments on every page", async () => {
    await bookFive();
    const p2 = await list(owner, "&pageSize=2&page=2");
    expect(p2.appointments.every((a) => a.services[0]?.name === "Haircut")).toBe(true);
  });

  test("invalid paging is a 400", async () => {
    for (const q of ["&page=0", "&pageSize=0", "&pageSize=201", "&page=x"]) {
      const res = await json(t.app, `/appointments?${RANGE}${q}`, "GET", undefined, owner.cookie);
      expect([q, res.status]).toEqual([q, 400]);
      expect(errorResponseSchema.parse(await res.json()).error.code).toBe("validation_error");
    }
  });
});

describe("status filter", () => {
  async function mixedStatuses() {
    const [a, b, c, d] = await bookFive();
    if (!a || !b || !c || !d) throw new Error("fixture");
    await json(
      t.app,
      `/appointments/${a.id}`,
      "PATCH",
      { version: a.version, status: "cancelled" },
      owner.cookie,
    );
    await t.db.update(appointment).set({ status: "completed" }).where(eq(appointment.id, b.id));
    await t.db.update(appointment).set({ status: "no_show" }).where(eq(appointment.id, c.id));
    return { cancelled: a, completed: b, noShow: c, booked: d };
  }

  test("a single status", async () => {
    const m = await mixedStatuses();
    expect((await list(owner, "&status=cancelled")).appointments.map((a) => a.id)).toEqual([
      m.cancelled.id,
    ]);
    const booked = await list(owner, "&status=booked");
    expect(booked.total).toBe(2);
  });

  test("several statuses at once, with a total that respects the filter", async () => {
    const m = await mixedStatuses();
    const body = await list(owner, "&status=completed,no_show&pageSize=1");
    expect(body.total).toBe(2);
    expect(body.appointments.map((a) => a.id)).toEqual([m.completed.id]);
  });

  test("unknown or repeated statuses are a 400", async () => {
    for (const q of ["&status=done", "&status=booked,booked", "&status="]) {
      const res = await json(t.app, `/appointments?${RANGE}${q}`, "GET", undefined, owner.cookie);
      expect([q, res.status]).toEqual([q, 400]);
    }
  });
});

describe("role scoping still applies to paged results", () => {
  test("staff only count and see their own calendar; clients only their own appointments", async () => {
    await bookFive();
    await json(
      t.app,
      "/appointments",
      "POST",
      { staffId: f.beaId, serviceIds: [f.haircutId], startsAt: "2026-03-09T12:00:00.000Z" },
      clientA.cookie,
    );
    expect((await list(owner)).total).toBe(6);
    expect((await list(ana)).total).toBe(5);
    const mine = await list(clientA, "&pageSize=1");
    expect(mine.total).toBe(1);
    expect(mine.appointments[0]?.clientId).toBe(clientA.clientId ?? "");
  });
});
