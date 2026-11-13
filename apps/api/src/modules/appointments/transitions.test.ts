import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, appointmentService, auditLog } from "@sob/db";
import { asc, eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let ana: Actor;
let bea: Actor;
let client: Actor;
let otherClient: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, ana, bea, client, otherClient] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "c@example.com"),
    actor(t, "client", "d@example.com"),
  ]);
});

const patch = (who: Actor, id: string, body: Record<string, unknown>) =>
  json(t.app, `/appointments/${id}`, "PATCH", body, who.cookie);
const errorCode = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;
const audit = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));
const row = async (id: string) => {
  const [r] = await t.db.select().from(appointment).where(eq(appointment.id, id));
  if (!r) throw new Error("missing appointment");
  return r;
};

/** The fixture clock is Mon 2026-03-02 12:00Z. Inserts straight into the table to get a past one. */
async function insertAt(
  startsAt: Date,
  over: { staffId?: string; clientId?: string; status?: "booked" | "completed" | "no_show" } = {},
) {
  const [r] = await t.db
    .insert(appointment)
    .values({
      staffId: over.staffId ?? f.anaId,
      clientId: over.clientId ?? f.clientId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: over.status ?? "booked",
    })
    .returning();
  if (!r) throw new Error("insert failed");
  await t.db.insert(appointmentService).values({
    appointmentId: r.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Haircut",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 10000,
    currency: "ARS",
  });
  return r;
}
const PAST = new Date("2026-02-27T12:00:00Z");

async function bookFuture(who: Actor = owner, over: Record<string, unknown> = {}) {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: who.clientId ?? f.clientId,
      ...over,
    },
    who.cookie,
  );
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

describe("booked -> completed | no_show", () => {
  test("the owner marks a past appointment completed: version bumps, times untouched, audited", async () => {
    const past = await insertAt(PAST);
    const res = await patch(owner, past.id, { version: 1, status: "completed" });
    expect(res.status).toBe(200);
    expect(appointmentSchema.parse(await res.json())).toMatchObject({
      status: "completed",
      version: 2,
      startsAt: PAST.toISOString(),
      staffId: f.anaId,
    });
    const [entry] = await audit("appointment.complete");
    expect(entry).toMatchObject({
      actorUserId: owner.userId,
      entity: "appointment",
      entityId: past.id,
    });
    expect(entry?.metadata).toMatchObject({
      fromStatus: "booked",
      toStatus: "completed",
      version: 2,
    });
  });

  test("the calendar's own staff member can mark no_show; another staff member cannot", async () => {
    const past = await insertAt(PAST);
    const denied = await patch(bea, past.id, { version: 1, status: "no_show" });
    expect(denied.status).toBe(403);
    expect((await row(past.id)).status).toBe("booked");

    const ok = await patch(ana, past.id, { version: 1, status: "no_show" });
    expect(ok.status).toBe(200);
    expect(appointmentSchema.parse(await ok.json()).status).toBe("no_show");
    expect((await audit("appointment.no_show")).length).toBe(1);
  });

  test("clients cannot mark outcomes, not even on their own appointment", async () => {
    const past = await insertAt(PAST, { clientId: client.clientId ?? "" });
    for (const status of ["completed", "no_show"]) {
      const res = await patch(client, past.id, { version: 1, status });
      expect([status, res.status]).toEqual([status, 403]);
    }
    expect((await row(past.id)).status).toBe("booked");
  });

  test("only once the appointment has started: a future one is 409 invalid_state", async () => {
    const future = await bookFuture();
    for (const status of ["completed", "no_show"]) {
      const res = await patch(owner, future.id, { version: 1, status });
      expect([status, res.status]).toEqual([status, 409]);
      expect(await errorCode(res)).toBe("invalid_state");
    }
    expect(await row(future.id)).toMatchObject({ status: "booked", version: 1 });
    expect((await audit("appointment.complete")).length).toBe(0);
  });

  test("the start instant itself counts as started; one millisecond earlier does not", async () => {
    const atNow = await insertAt(NOW);
    expect((await patch(owner, atNow.id, { version: 1, status: "completed" })).status).toBe(200);
    const justAfter = await insertAt(new Date(NOW.getTime() + 1), { staffId: f.beaId });
    expect((await patch(owner, justAfter.id, { version: 1, status: "completed" })).status).toBe(
      409,
    );
  });

  test("a stale version is 409 version_conflict and changes nothing", async () => {
    const past = await insertAt(PAST);
    const res = await patch(owner, past.id, { version: 7, status: "completed" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("version_conflict");
    expect((await row(past.id)).status).toBe("booked");
    expect((await audit("appointment.complete")).length).toBe(0);
  });

  test("notes may travel with the status change", async () => {
    const past = await insertAt(PAST);
    const res = await patch(owner, past.id, {
      version: 1,
      status: "completed",
      notes: "Paid cash",
    });
    expect(appointmentSchema.parse(await res.json())).toMatchObject({
      status: "completed",
      notes: "Paid cash",
    });
  });

  test("a status change combined with a move is a 400", async () => {
    const past = await insertAt(PAST);
    const res = await patch(owner, past.id, {
      version: 1,
      status: "completed",
      startsAt: MONDAY_0900,
    });
    expect(res.status).toBe(400);
  });
});

describe("completed <-> no_show corrections", () => {
  test("the owner can correct in both directions, audited as a correction", async () => {
    const past = await insertAt(PAST);
    await patch(ana, past.id, { version: 1, status: "completed" });
    const fixed = await patch(owner, past.id, { version: 2, status: "no_show" });
    expect(fixed.status).toBe(200);
    expect(appointmentSchema.parse(await fixed.json())).toMatchObject({
      status: "no_show",
      version: 3,
    });
    const back = await patch(owner, past.id, { version: 3, status: "completed" });
    expect(back.status).toBe(200);
    const corrections = await audit("appointment.status_correct");
    expect(corrections.map((c) => c.metadata)).toEqual([
      expect.objectContaining({ fromStatus: "completed", toStatus: "no_show" }),
      expect.objectContaining({ fromStatus: "no_show", toStatus: "completed" }),
    ]);
  });

  test("staff cannot correct, even on their own calendar", async () => {
    const past = await insertAt(PAST);
    await patch(ana, past.id, { version: 1, status: "completed" });
    const res = await patch(ana, past.id, { version: 2, status: "no_show" });
    expect(res.status).toBe(403);
    expect((await row(past.id)).status).toBe("completed");
  });

  test("setting the status it already has is 409 invalid_state", async () => {
    const past = await insertAt(PAST, { status: "completed" });
    const res = await patch(owner, past.id, { version: 1, status: "completed" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("invalid_state");
  });

  test("an outcome cannot be cancelled afterwards", async () => {
    const past = await insertAt(PAST, { status: "no_show" });
    const res = await patch(owner, past.id, { version: 1, status: "cancelled" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("invalid_state");
  });
});

describe("cancelled is terminal", () => {
  test("a cancelled appointment cannot become completed or no_show", async () => {
    const booked = await bookFuture();
    expect((await patch(owner, booked.id, { version: 1, status: "cancelled" })).status).toBe(200);
    for (const status of ["completed", "no_show", "cancelled"]) {
      const res = await patch(owner, booked.id, { version: 2, status });
      expect([status, res.status]).toEqual([status, 409]);
      expect(await errorCode(res)).toBe("invalid_state");
    }
    expect((await row(booked.id)).status).toBe("cancelled");
  });

  test("a past, still-booked appointment can be cancelled", async () => {
    const past = await insertAt(PAST);
    expect((await patch(owner, past.id, { version: 1, status: "cancelled" })).status).toBe(200);
  });
});

describe("clients and cancellation", () => {
  test("a client cancels their own appointment but not someone else's", async () => {
    const mine = await bookFuture(client);
    const res = await patch(client, mine.id, { version: 1, status: "cancelled" });
    expect(res.status).toBe(200);
    expect(appointmentSchema.parse(await res.json()).status).toBe("cancelled");
    expect((await audit("appointment.cancel")).length).toBe(1);

    const theirs = await bookFuture(otherClient, { startsAt: "2026-03-09T15:00:00.000Z" });
    expect((await patch(client, theirs.id, { version: 1, status: "cancelled" })).status).toBe(403);
  });
});
