import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgErrorCode } from "./errors";
import { appointment, clientProfile, salonSettings, staffProfile } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("db");
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

async function seedStaffAndClient() {
  const [staff] = await t.db.insert(staffProfile).values({ displayName: "Ana" }).returning();
  const [staff2] = await t.db.insert(staffProfile).values({ displayName: "Bea" }).returning();
  const [client] = await t.db.insert(clientProfile).values({ name: "Lucia" }).returning();
  if (!staff || !staff2 || !client) throw new Error("seed failed");
  return { staff, staff2, client };
}

function slot(startsAt: string, minutes: number) {
  const start = new Date(startsAt);
  return { startsAt: start, endsAt: new Date(start.getTime() + minutes * 60_000) };
}

describe("appointment exclusion constraint", () => {
  test("rejects an overlapping appointment for the same staff with SQLSTATE 23P01", async () => {
    const { staff, client } = await seedStaffAndClient();
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });

    const attempt = t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:30:00Z", 60) });

    expect(attempt).rejects.toBeDefined();
    const error = await attempt.catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23P01");
  });

  test("allows back-to-back appointments (ranges are half-open)", async () => {
    const { staff, client } = await seedStaffAndClient();
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T13:00:00Z", 60) });
  });

  test("allows the same time for a different staff member", async () => {
    const { staff, staff2, client } = await seedStaffAndClient();
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });
    await t.db
      .insert(appointment)
      .values({ staffId: staff2.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });
  });

  test("cancelled appointments do not block the slot", async () => {
    const { staff, client } = await seedStaffAndClient();
    await t.db.insert(appointment).values({
      staffId: staff.id,
      clientId: client.id,
      status: "cancelled",
      ...slot("2026-03-09T12:00:00Z", 60),
    });
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });
  });

  test("completed and no_show appointments still block the slot", async () => {
    const { staff, client } = await seedStaffAndClient();
    for (const [status, start] of [
      ["completed", "2026-03-09T12:00:00Z"],
      ["no_show", "2026-03-09T15:00:00Z"],
    ] as const) {
      await t.db
        .insert(appointment)
        .values({ staffId: staff.id, clientId: client.id, status, ...slot(start, 60) });
      const error = await t.db
        .insert(appointment)
        .values({ staffId: staff.id, clientId: client.id, ...slot(start, 30) })
        .catch((e: unknown) => e);
      expect(pgErrorCode(error)).toBe("23P01");
    }
  });

  test("soft-deleted appointments do not block the slot", async () => {
    const { staff, client } = await seedStaffAndClient();
    await t.db.insert(appointment).values({
      staffId: staff.id,
      clientId: client.id,
      deletedAt: new Date(),
      ...slot("2026-03-09T12:00:00Z", 60),
    });
    await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) });
  });

  test("rejects ends_at <= starts_at with SQLSTATE 23514", async () => {
    const { staff, client } = await seedStaffAndClient();
    const error = await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 0) })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23514");
  });

  test("the constraint and the btree_gist extension exist", async () => {
    const rows = await t.db.execute(sql`
      select
        (select count(*)::int from pg_extension where extname = 'btree_gist') as ext,
        (select count(*)::int from pg_constraint
           where conname = 'appointment_no_overlap' and contype = 'x') as excl
    `);
    expect(rows[0]).toEqual({ ext: 1, excl: 1 });
  });
});

describe("keys and defaults", () => {
  test("generates UUIDv7 primary keys in application code", async () => {
    const [row] = await t.db.insert(staffProfile).values({ displayName: "Ana" }).returning();
    // The version nibble is the first character of the third group.
    expect(row?.id.split("-")[2]?.[0]).toBe("7");
  });

  test("accepts a client-generated id", async () => {
    const id = Bun.randomUUIDv7();
    const [row] = await t.db.insert(clientProfile).values({ id, name: "Lucia" }).returning();
    expect(row?.id).toBe(id);
  });

  test("appointment starts at version 1 and status booked", async () => {
    const { staff, client } = await seedStaffAndClient();
    const [row] = await t.db
      .insert(appointment)
      .values({ staffId: staff.id, clientId: client.id, ...slot("2026-03-09T12:00:00Z", 60) })
      .returning();
    expect(row?.version).toBe(1);
    expect(row?.status).toBe("booked");
  });

  test("salon_settings is a single-row table", async () => {
    const values = {
      name: "Sisters of Beauty",
      timezone: "America/Argentina/Buenos_Aires",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 60,
      maxDaysAhead: 60,
    };
    await t.db.insert(salonSettings).values(values);
    const error = await t.db
      .insert(salonSettings)
      .values({ ...values, id: 2 })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23514");
  });
});
