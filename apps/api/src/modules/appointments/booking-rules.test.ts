import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, auditLog, clientProfile, timeOff } from "@sob/db";
import { count, eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
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
});

/** Fixture clock is Mon 2026-03-02 09:00 local; min notice 60 min; max 90 days; Mon 09-18. */
const book = (who: Actor, over: Record<string, unknown> = {}) =>
  json(
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

async function code(res: Response) {
  return errorResponseSchema.parse(await res.json()).error;
}

describe("POST /appointments enforces working hours and time off", () => {
  test("a booking before opening is slot_unavailable and writes nothing", async () => {
    const res = await book(owner, { startsAt: "2026-03-09T11:00:00.000Z" }); // 08:00 local
    expect(res.status).toBe(409);
    const error = await code(res);
    expect(error.code).toBe("slot_unavailable");
    expect(error.message).toContain("working hours");
    const [{ n } = { n: -1 }] = await t.db.select({ n: count() }).from(appointment);
    expect(n).toBe(0);
  });

  test("a booking whose block (duration + buffer) ends after closing is refused", async () => {
    // haircut block is 60 min; 17:30 local would end at 18:30
    const res = await book(owner, { startsAt: "2026-03-09T20:30:00.000Z" });
    expect(res.status).toBe(409);
    expect((await code(res)).code).toBe("slot_unavailable");
    // 17:00 local ends exactly at closing
    expect((await book(owner, { startsAt: "2026-03-09T20:00:00.000Z" })).status).toBe(201);
  });

  test("a day without working hours is refused", async () => {
    const res = await book(owner, { startsAt: "2026-03-10T12:00:00.000Z" }); // Tuesday
    expect(res.status).toBe(409);
    expect((await code(res)).code).toBe("slot_unavailable");
  });

  test("time off blocks the booking, and the override flag does not bypass it", async () => {
    await t.db.insert(timeOff).values({
      staffId: f.anaId,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T14:00:00Z"),
    });
    const res = await book(owner);
    expect(res.status).toBe(409);
    const error = await code(res);
    expect(error.code).toBe("slot_unavailable");
    expect(error.message).toContain("time off");
    expect((await book(owner, { override: true })).status).toBe(409);
    // the other staff member is unaffected
    expect((await book(owner, { staffId: f.beaId })).status).toBe(201);
  });

  test("a rejected inline-client booking does not leave an orphan client", async () => {
    const res = await book(owner, {
      clientId: undefined,
      client: { name: "Marta", email: "marta@example.com" },
      startsAt: "2026-03-10T12:00:00.000Z",
    });
    expect(res.status).toBe(409);
    const [{ n } = { n: -1 }] = await t.db
      .select({ n: count() })
      .from(clientProfile)
      .where(eq(clientProfile.email, "marta@example.com"));
    expect(n).toBe(0);
  });
});

describe("POST /appointments enforces min notice and max days ahead", () => {
  const SOON = "2026-03-02T12:30:00.000Z"; // 30 min after the fixture clock

  test("a client inside the notice window is refused", async () => {
    const res = await book(client, { startsAt: SOON });
    expect(res.status).toBe(409);
    const error = await code(res);
    expect(error.code).toBe("slot_unavailable");
    expect(error.message).toContain("notice");
  });

  test("exactly the minimum notice is accepted", async () => {
    expect((await book(client, { startsAt: "2026-03-02T13:00:00.000Z" })).status).toBe(201);
  });

  test("beyond max days ahead is refused", async () => {
    // 2026-06-08 is a Monday, 98 days after the fixture clock (limit is 90)
    const res = await book(owner, { startsAt: "2026-06-08T12:00:00.000Z" });
    expect(res.status).toBe(409);
    const error = await code(res);
    expect(error.code).toBe("slot_unavailable");
    expect(error.message).toContain("days");
  });

  test("the owner can override min notice and the override is audited", async () => {
    const res = await book(owner, { startsAt: SOON, override: true });
    expect(res.status).toBe(201);
    const created = appointmentSchema.parse(await res.json());
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, created.id));
    expect(row?.action).toBe("appointment.create");
    expect(row?.metadata).toMatchObject({ override: true, noticeOverridden: true });
  });

  test("staff can override min notice on their own calendar", async () => {
    expect((await book(ana, { startsAt: SOON, override: true })).status).toBe(201);
  });

  test("an unnecessary override is not flagged as a notice override", async () => {
    const res = await book(owner, { override: true });
    expect(res.status).toBe(201);
    const created = appointmentSchema.parse(await res.json());
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, created.id));
    expect(row?.metadata).toMatchObject({ override: true, noticeOverridden: false });
  });

  test("a client cannot use the override flag", async () => {
    const res = await book(client, { startsAt: SOON, override: true });
    expect(res.status).toBe(403);
    expect((await code(res)).code).toBe("forbidden");
  });

  test("override does not bypass max days ahead or working hours", async () => {
    expect(
      (await book(owner, { startsAt: "2026-06-08T12:00:00.000Z", override: true })).status,
    ).toBe(409);
    expect(
      (await book(owner, { startsAt: "2026-03-09T11:00:00.000Z", override: true })).status,
    ).toBe(409);
  });
});
