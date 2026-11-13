import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  appointmentSchema,
  errorResponseSchema,
  listAppointmentsResponseSchema,
} from "@sob/contracts";
import { appointment, clientProfile } from "@sob/db";
import { count, eq } from "drizzle-orm";
import {
  countOverlaps,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
});

function bookingBody(overrides: Record<string, unknown> = {}) {
  return {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
    clientId: f.clientId,
    ...overrides,
  };
}

async function book(overrides: Record<string, unknown> = {}) {
  return json(t.app, "/appointments", "POST", bookingBody(overrides));
}

async function errorCode(res: Response) {
  return errorResponseSchema.parse(await res.json()).error.code;
}

describe("POST /appointments", () => {
  test("creates an appointment with service snapshots and buffer-inclusive end time", async () => {
    const res = await book({ serviceIds: [f.haircutId, f.colorId], notes: "First visit" });
    expect(res.status).toBe(201);
    const body = appointmentSchema.parse(await res.json());
    expect(body).toMatchObject({
      staffId: f.anaId,
      clientId: f.clientId,
      status: "booked",
      version: 1,
      notes: "First visit",
      startsAt: MONDAY_0900,
      // (45 + 15) + (90 + 0) = 150 minutes
      endsAt: "2026-03-09T14:30:00.000Z",
    });
    expect(
      body.services.map((s) => [s.name, s.durationMinutes, s.bufferMinutes, s.priceCents]),
    ).toEqual([
      ["Haircut", 45, 15, 10000],
      ["Color", 90, 0, 25000],
    ]);
  });

  test("creates the client from an inline payload and reuses it by email", async () => {
    const client = { name: "Marta", email: "marta@example.com" };
    const first = appointmentSchema.parse(
      await (await book({ clientId: undefined, client })).json(),
    );
    const second = appointmentSchema.parse(
      await (
        await book({
          clientId: undefined,
          client,
          staffId: f.beaId,
        })
      ).json(),
    );
    expect(second.clientId).toBe(first.clientId);
    const [{ n } = { n: 0 }] = await t.db.select({ n: count() }).from(clientProfile);
    expect(n).toBe(2); // fixture client + Marta
  });

  test("accepts a client-generated id and rejects reusing it", async () => {
    const id = Bun.randomUUIDv7();
    const res = await book({ id });
    expect(res.status).toBe(201);
    expect(appointmentSchema.parse(await res.json()).id).toBe(id);
    const again = await book({ id, startsAt: "2026-03-09T16:00:00.000Z" });
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe("invalid_state");
  });

  test("returns 409 slot_taken for the same slot and for any overlap", async () => {
    expect((await book()).status).toBe(201);
    const same = await book();
    expect(same.status).toBe(409);
    expect(await errorCode(same)).toBe("slot_taken");
    const partial = await book({ startsAt: "2026-03-09T12:30:00.000Z" });
    expect(partial.status).toBe(409);
    expect(await errorCode(partial)).toBe("slot_taken");
    // Back-to-back (block is 60 minutes) and other staff members are fine.
    expect((await book({ startsAt: "2026-03-09T13:00:00.000Z" })).status).toBe(201);
    expect((await book({ staffId: f.beaId })).status).toBe(201);
  });

  test("a rejected booking does not leave an orphan client behind", async () => {
    expect((await book()).status).toBe(201);
    const res = await book({ clientId: undefined, client: { name: "Ghost" } });
    expect(res.status).toBe(409);
    const [{ n } = { n: 0 }] = await t.db.select({ n: count() }).from(clientProfile);
    expect(n).toBe(1);
  });

  test("returns 404 for unknown staff, service or client", async () => {
    const unknown = "0198f5a0-7b1c-7000-8000-0000000000ff";
    for (const overrides of [
      { staffId: unknown },
      { serviceIds: [unknown] },
      { clientId: unknown },
    ]) {
      const res = await book(overrides);
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe("not_found");
    }
  });

  test("returns 400 when the staff member does not perform a service", async () => {
    const res = await book({ staffId: f.beaId, serviceIds: [f.colorId] });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });

  test("returns 400 validation_error for invalid bodies", async () => {
    for (const overrides of [
      { serviceIds: [] },
      { startsAt: "tomorrow" },
      { clientId: undefined },
    ]) {
      const res = await book(overrides);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation_error");
    }
    const malformed = await t.app.request("/appointments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("validation_error");
  });
});

describe("GET /appointments", () => {
  test("lists appointments overlapping the range, optionally by staff", async () => {
    await book();
    await book({ staffId: f.beaId, startsAt: "2026-03-09T15:00:00.000Z" });
    await book({ startsAt: "2026-03-10T12:00:00.000Z" });

    const range = "from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z";
    const all = listAppointmentsResponseSchema.parse(
      await (await t.app.request(`/appointments?${range}`)).json(),
    );
    expect(all.appointments.map((a) => a.startsAt)).toEqual([
      MONDAY_0900,
      "2026-03-09T15:00:00.000Z",
    ]);
    expect(all.appointments[0]?.services[0]?.name).toBe("Haircut");

    const ana = listAppointmentsResponseSchema.parse(
      await (await t.app.request(`/appointments?${range}&staffId=${f.anaId}`)).json(),
    );
    expect(ana.appointments).toHaveLength(1);
  });

  test("returns 400 validation_error without a range", async () => {
    const res = await t.app.request("/appointments");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });
});

describe("PATCH /appointments/:id", () => {
  async function created() {
    return appointmentSchema.parse(await (await book()).json());
  }

  test("cancels with the current version and bumps it", async () => {
    const a = await created();
    const res = await json(t.app, `/appointments/${a.id}`, "PATCH", {
      version: a.version,
      status: "cancelled",
    });
    expect(res.status).toBe(200);
    const body = appointmentSchema.parse(await res.json());
    expect(body.status).toBe("cancelled");
    expect(body.version).toBe(2);
  });

  test("a cancelled appointment frees the slot for a new booking", async () => {
    const a = await created();
    expect((await book()).status).toBe(409);
    await json(t.app, `/appointments/${a.id}`, "PATCH", { version: 1, status: "cancelled" });
    expect((await book()).status).toBe(201);
  });

  test("returns 409 version_conflict for a stale version and changes nothing", async () => {
    const a = await created();
    await json(t.app, `/appointments/${a.id}`, "PATCH", { version: 1, notes: "first edit" });
    const stale = await json(t.app, `/appointments/${a.id}`, "PATCH", {
      version: 1,
      status: "cancelled",
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe("version_conflict");
    const [row] = await t.db.select().from(appointment);
    expect(row?.status).toBe("booked");
    expect(row?.version).toBe(2);
  });

  test("reschedules keeping the duration, optionally to another staff member", async () => {
    const a = await created();
    const moved = await json(t.app, `/appointments/${a.id}`, "PATCH", {
      version: 1,
      startsAt: "2026-03-09T15:00:00.000Z",
      staffId: f.beaId,
    });
    expect(moved.status).toBe(200);
    const body = appointmentSchema.parse(await moved.json());
    expect(body).toMatchObject({
      staffId: f.beaId,
      startsAt: "2026-03-09T15:00:00.000Z",
      endsAt: "2026-03-09T16:00:00.000Z",
      version: 2,
    });
  });

  test("rescheduling into a taken slot returns 409 slot_taken and keeps the original", async () => {
    const a = await created();
    await book({ startsAt: "2026-03-09T15:00:00.000Z" });
    const res = await json(t.app, `/appointments/${a.id}`, "PATCH", {
      version: 1,
      startsAt: "2026-03-09T15:30:00.000Z",
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("slot_taken");
    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, a.id));
    expect(row?.startsAt.toISOString()).toBe(MONDAY_0900);
    expect(row?.version).toBe(1);
  });

  test("rejects rescheduling to staff who cannot perform the booked services", async () => {
    const a = appointmentSchema.parse(await (await book({ serviceIds: [f.colorId] })).json());
    const res = await json(t.app, `/appointments/${a.id}`, "PATCH", {
      version: 1,
      staffId: f.beaId,
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("validation_error");
  });

  test("cancelled appointments cannot be rescheduled or cancelled again", async () => {
    const a = await created();
    await json(t.app, `/appointments/${a.id}`, "PATCH", { version: 1, status: "cancelled" });
    for (const change of [{ startsAt: "2026-03-09T15:00:00.000Z" }, { status: "cancelled" }]) {
      const res = await json(t.app, `/appointments/${a.id}`, "PATCH", { version: 2, ...change });
      expect(res.status).toBe(409);
      expect(await errorCode(res)).toBe("invalid_state");
    }
  });

  test("returns 404 for an unknown appointment and 400 for an invalid body", async () => {
    const missing = await json(t.app, `/appointments/${Bun.randomUUIDv7()}`, "PATCH", {
      version: 1,
      status: "cancelled",
    });
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe("not_found");

    const a = await created();
    for (const body of [{}, { version: 1 }, { status: "cancelled" }]) {
      const res = await json(t.app, `/appointments/${a.id}`, "PATCH", body);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation_error");
    }
    const badId = await json(t.app, "/appointments/not-a-uuid", "PATCH", {
      version: 1,
      status: "cancelled",
    });
    expect(badId.status).toBe(400);
  });
});

describe("concurrency", () => {
  test("N concurrent bookings for the same slot: exactly one 201, the rest 409 slot_taken", async () => {
    const N = 20;
    const responses = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        book({ clientId: undefined, client: { name: `Client ${i}` } }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(N - 1);
    for (const res of responses.filter((r) => r.status === 409)) {
      expect(await errorCode(res)).toBe("slot_taken");
    }
    const [{ n } = { n: 0 }] = await t.db.select({ n: count() }).from(appointment);
    expect(n).toBe(1);
    expect(await countOverlaps(t.db)).toBe(0);
  });

  test("concurrent bookings with staggered overlapping starts never double-book", async () => {
    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        book({
          startsAt: new Date(Date.parse(MONDAY_0900) + i * 15 * 60_000).toISOString(),
        }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(await countOverlaps(t.db)).toBe(0);
  });

  test("concurrent PATCHes with the same version: exactly one wins", async () => {
    const a = appointmentSchema.parse(await (await book()).json());
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        json(t.app, `/appointments/${a.id}`, "PATCH", { version: 1, notes: `edit ${i}` }),
      ),
    );
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(7);
  });
});
