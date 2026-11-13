import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  appointmentSchema,
  availabilityResponseSchema,
  errorResponseSchema,
  listAppointmentsResponseSchema,
} from "@sob/contracts";
import { appointment, clientProfile } from "@sob/db";
import { count, eq } from "drizzle-orm";
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
let ana: Actor; // staff, owns the Ana calendar
let bea: Actor; // staff, owns the Bea calendar
let clientA: Actor;
let clientB: Actor;

const RANGE = "from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  // Password hashing is deliberately slow, so create the accounts in parallel.
  [owner, ana, bea, clientA, clientB] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "a@example.com"),
    actor(t, "client", "b@example.com"),
  ]);
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
    ...overrides,
  };
}

const book = (who: Actor | null, overrides: Record<string, unknown> = {}) =>
  json(t.app, "/appointments", "POST", body(overrides), who?.cookie);

const patch = (who: Actor | null, id: string, change: Record<string, unknown>) =>
  json(t.app, `/appointments/${id}`, "PATCH", change, who?.cookie);

const list = (who: Actor | null, query = RANGE) =>
  json(t.app, `/appointments?${query}`, "GET", undefined, who?.cookie);

async function code(res: Response) {
  return errorResponseSchema.parse(await res.json()).error.code;
}

async function bookAs(who: Actor, overrides: Record<string, unknown> = {}) {
  const res = await book(who, overrides);
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

describe("public endpoints stay public", () => {
  test("health, services, staff and availability need no login", async () => {
    expect((await json(t.app, "/health", "GET")).status).toBe(200);
    expect((await json(t.app, "/services", "GET")).status).toBe(200);
    expect((await json(t.app, "/staff", "GET")).status).toBe(200);
    const availability = await json(
      t.app,
      `/availability?serviceIds=${f.haircutId}&staffId=${f.anaId}&date=${MONDAY}`,
      "GET",
    );
    expect(availability.status).toBe(200);
    availabilityResponseSchema.parse(await availability.json());
  });
});

describe("anonymous callers", () => {
  test("cannot book: guest booking is out of scope and answers 401 unauthorized", async () => {
    const res = await book(null, { client: { name: "Guest", email: "guest@example.com" } });
    expect(res.status).toBe(401);
    expect(await code(res)).toBe("unauthorized");
    expect(await t.db.select().from(appointment)).toHaveLength(0);
  });

  test("cannot list or change appointments", async () => {
    const a = await bookAs(owner, { clientId: f.clientId });
    const listed = await list(null);
    expect(listed.status).toBe(401);
    expect(await code(listed)).toBe("unauthorized");
    const changed = await patch(null, a.id, { version: 1, status: "cancelled" });
    expect(changed.status).toBe(401);
    expect(await code(changed)).toBe("unauthorized");
  });

  test("a forged or expired session cookie is anonymous too", async () => {
    const res = await json(t.app, "/appointments", "POST", body(), "better-auth.session_token=x.y");
    expect(res.status).toBe(401);
  });
});

describe("clients", () => {
  test("book for themselves and the appointment is linked to their own profile", async () => {
    const a = await bookAs(clientA);
    expect(a.clientId).toBe(clientA.clientId as string);
  });

  test("cannot book on behalf of someone else, by id or by inline payload", async () => {
    const forgedId = await book(clientA, { clientId: clientB.clientId });
    expect(forgedId.status).toBe(403);
    expect(await code(forgedId)).toBe("forbidden");

    const before = (await t.db.select({ n: count() }).from(clientProfile))[0]?.n ?? 0;
    const inline = await book(clientA, { client: { name: "Mallory", email: "m@example.com" } });
    expect(inline.status).toBe(201);
    expect(appointmentSchema.parse(await inline.json()).clientId).toBe(clientA.clientId as string);
    const after = (await t.db.select({ n: count() }).from(clientProfile))[0]?.n ?? 0;
    expect(after).toBe(before);
  });

  test("can reschedule and cancel their own appointment", async () => {
    const a = await bookAs(clientA);
    const moved = await patch(clientA, a.id, { version: 1, startsAt: "2026-03-09T15:00:00.000Z" });
    expect(moved.status).toBe(200);
    const cancelled = await patch(clientA, a.id, { version: 2, status: "cancelled" });
    expect(cancelled.status).toBe(200);
    expect(appointmentSchema.parse(await cancelled.json()).status).toBe("cancelled");
  });

  test("client B cannot reschedule, cancel or annotate client A's appointment", async () => {
    const a = await bookAs(clientA);
    for (const change of [
      { version: 1, status: "cancelled" },
      { version: 1, startsAt: "2026-03-09T15:00:00.000Z" },
      { version: 1, notes: "hijacked" },
    ]) {
      const res = await patch(clientB, a.id, change);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
    }
    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, a.id));
    expect(row).toMatchObject({ status: "booked", version: 1, notes: null });
  });

  test("an unknown appointment is 404 for everyone, so ids are not probed through 403", async () => {
    const res = await patch(clientB, Bun.randomUUIDv7(), { version: 1, status: "cancelled" });
    expect(res.status).toBe(404);
  });

  test("GET /appointments returns only their own appointments", async () => {
    const mine = await bookAs(clientA);
    await bookAs(clientB, { startsAt: "2026-03-09T15:00:00.000Z" });
    await bookAs(owner, { startsAt: "2026-03-09T17:00:00.000Z", clientId: f.clientId });

    const asA = listAppointmentsResponseSchema.parse(await (await list(clientA)).json());
    expect(asA.appointments.map((a) => a.id)).toEqual([mine.id]);
    const asB = listAppointmentsResponseSchema.parse(await (await list(clientB)).json());
    expect(asB.appointments).toHaveLength(1);
    expect(asB.appointments[0]?.clientId).toBe(clientB.clientId as string);
  });

  test("a staffId filter cannot widen what a client sees", async () => {
    await bookAs(clientB, { startsAt: "2026-03-09T15:00:00.000Z" });
    const res = await list(clientA, `${RANGE}&staffId=${f.anaId}`);
    expect(listAppointmentsResponseSchema.parse(await res.json()).appointments).toEqual([]);
  });
});

describe("staff", () => {
  test("see and manage appointments on their own calendar", async () => {
    const a = await bookAs(clientA); // on Ana's calendar
    const seen = listAppointmentsResponseSchema.parse(await (await list(ana)).json());
    expect(seen.appointments.map((x) => x.id)).toEqual([a.id]);
    const cancelled = await patch(ana, a.id, { version: 1, status: "cancelled" });
    expect(cancelled.status).toBe(200);
  });

  test("do not see another staff member's calendar and cannot touch it", async () => {
    const onBea = await bookAs(clientA, { staffId: f.beaId });
    const seen = listAppointmentsResponseSchema.parse(await (await list(ana)).json());
    expect(seen.appointments).toEqual([]);

    const asked = await list(ana, `${RANGE}&staffId=${f.beaId}`);
    expect(asked.status).toBe(403);
    expect(await code(asked)).toBe("forbidden");

    const res = await patch(ana, onBea.id, { version: 1, status: "cancelled" });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("forbidden");
    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, onBea.id));
    expect(row?.status).toBe("booked");
  });

  test("book into their own calendar for a client, but not into someone else's", async () => {
    const ok = await book(ana, { clientId: f.clientId });
    expect(ok.status).toBe(201);
    const other = await book(ana, { staffId: f.beaId, clientId: f.clientId });
    expect(other.status).toBe(403);
    expect(await code(other)).toBe("forbidden");
  });

  test("cannot push their own appointment onto another calendar", async () => {
    const a = await bookAs(clientA);
    const res = await patch(ana, a.id, { version: 1, staffId: f.beaId });
    expect(res.status).toBe(403);
    // The other staff member cannot pull it over either.
    const pulled = await patch(bea, a.id, { version: 1, staffId: f.beaId });
    expect(pulled.status).toBe(403);
  });

  test("staff are not clients: another client's appointment elsewhere stays hidden", async () => {
    await bookAs(clientB, { staffId: f.beaId, startsAt: "2026-03-09T15:00:00.000Z" });
    const seen = listAppointmentsResponseSchema.parse(await (await list(ana)).json());
    expect(seen.appointments).toEqual([]);
  });
});

describe("owner", () => {
  test("sees every appointment and can manage any of them", async () => {
    const a = await bookAs(clientA);
    const b = await bookAs(clientB, { staffId: f.beaId });
    const all = listAppointmentsResponseSchema.parse(await (await list(owner)).json());
    expect(all.appointments.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());

    const moved = await patch(owner, a.id, {
      version: 1,
      staffId: f.beaId,
      startsAt: "2026-03-09T18:00:00.000Z",
    });
    expect(moved.status).toBe(200);
    expect((await patch(owner, b.id, { version: 1, status: "cancelled" })).status).toBe(200);
  });

  test("can book for any client on any calendar", async () => {
    const res = await book(owner, { staffId: f.beaId, clientId: clientA.clientId });
    expect(res.status).toBe(201);
  });
});

describe("role changes take effect on live sessions", () => {
  test("a staff member demoted to client loses calendar access immediately", async () => {
    const a = await bookAs(clientA);
    expect((await patch(ana, a.id, { version: 1, notes: "ok" })).status).toBe(200);
    await t.db.execute(
      (await import("drizzle-orm")).sql`update "user" set role = 'client' where id = ${ana.userId}`,
    );
    const res = await patch(ana, a.id, { version: 2, notes: "still?" });
    expect(res.status).toBe(403);
  });
});
