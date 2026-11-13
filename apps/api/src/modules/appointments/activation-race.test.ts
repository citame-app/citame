import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema, errorResponseSchema } from "@sob/contracts";
import { appointment, staffProfile } from "@sob/db";
import { count, eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { lockCalendars } from "../../tx";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
});

async function waitForBlockedWriter() {
  for (let i = 0; i < 100; i++) {
    const rows = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await Bun.sleep(50);
  }
  throw new Error("the writer never blocked on the calendar lock");
}

/**
 * Deactivates a staff member inside a transaction that is held open, so a request that already
 * passed its pre-checks has to queue on the calendar lock. When the deactivation commits, the
 * queued request resumes and must notice that the calendar is gone.
 */
async function raceAgainstDeactivation(staffId: string, request: () => Promise<Response>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked!: () => void;
  const hasLock = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const deactivation = t.db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    await tx.update(staffProfile).set({ active: false }).where(eq(staffProfile.id, staffId));
    locked();
    await released;
  });
  await hasLock;
  const pending = request();
  await waitForBlockedWriter();
  release();
  await deactivation;
  return pending;
}

describe("a calendar deactivated while a write is queued behind it", () => {
  test("a booking that passed its pre-checks is refused, not committed", async () => {
    const res = await raceAgainstDeactivation(f.beaId, () =>
      json(
        t.app,
        "/appointments",
        "POST",
        {
          staffId: f.beaId,
          serviceIds: [f.haircutId],
          startsAt: MONDAY_0900,
          clientId: f.clientId,
        },
        owner.cookie,
      ),
    );
    expect(res.status).toBe(404);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("not_found");
    const [{ n } = { n: -1 }] = await t.db.select({ n: count() }).from(appointment);
    expect(n).toBe(0);
  });

  test("a reschedule onto that calendar is refused and the appointment stays put", async () => {
    const booked = appointmentSchema.parse(
      await (
        await json(
          t.app,
          "/appointments",
          "POST",
          {
            staffId: f.anaId,
            serviceIds: [f.haircutId],
            startsAt: MONDAY_0900,
            clientId: f.clientId,
          },
          owner.cookie,
        )
      ).json(),
    );
    const res = await raceAgainstDeactivation(f.beaId, () =>
      json(
        t.app,
        `/appointments/${booked.id}`,
        "PATCH",
        { version: booked.version, staffId: f.beaId },
        owner.cookie,
      ),
    );
    expect(res.status).toBe(404);
    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, booked.id));
    expect(row).toMatchObject({ staffId: f.anaId, version: 1 });
  });
});
