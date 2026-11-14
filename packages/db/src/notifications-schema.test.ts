import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgErrorCode } from "./errors";
import {
  appointment,
  clientProfile,
  notificationPreference,
  reminder,
  salonSettings,
  staffProfile,
} from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("db_notify");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function seedAppointment() {
  const [staff] = await t.db.insert(staffProfile).values({ displayName: "Ana" }).returning();
  const [client] = await t.db.insert(clientProfile).values({ name: "Lucia" }).returning();
  if (!staff || !client) throw new Error("seed failed");
  const [appt] = await t.db
    .insert(appointment)
    .values({
      staffId: staff.id,
      clientId: client.id,
      startsAt: new Date("2026-03-09T12:00:00Z"),
      endsAt: new Date("2026-03-09T13:00:00Z"),
    })
    .returning();
  if (!appt) throw new Error("seed failed");
  return { appt, client };
}

const base = (appointmentId: string) => ({
  appointmentId,
  kind: "reminder_24h" as const,
  channel: "email" as const,
  appointmentVersion: 1,
  scheduledFor: new Date("2026-03-08T12:00:00Z"),
});

describe("reminder table", () => {
  test("defaults to pending with zero attempts", async () => {
    const { appt } = await seedAppointment();
    const [row] = await t.db.insert(reminder).values(base(appt.id)).returning();
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.providerMessageId).toBeNull();
  });

  test("rejects a second row for the same (appointment, kind, channel, version)", async () => {
    const { appt } = await seedAppointment();
    await t.db.insert(reminder).values(base(appt.id));
    const error = await t.db
      .insert(reminder)
      .values(base(appt.id))
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23505");
  });

  test("allows the same kind for another channel or appointment version", async () => {
    const { appt } = await seedAppointment();
    await t.db.insert(reminder).values(base(appt.id));
    await t.db.insert(reminder).values({ ...base(appt.id), channel: "sms" });
    await t.db.insert(reminder).values({ ...base(appt.id), appointmentVersion: 2 });
  });

  test("is deleted with its appointment", async () => {
    const { appt } = await seedAppointment();
    await t.db.insert(reminder).values(base(appt.id));
    await t.db.execute(sql`delete from appointment where id = ${appt.id}`);
    const rows = await t.db.select().from(reminder);
    expect(rows).toHaveLength(0);
  });

  test("never writes to the sync log", async () => {
    const { appt } = await seedAppointment();
    const before = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sync_change`,
    );
    await t.db.insert(reminder).values(base(appt.id));
    const after = await t.db.execute<{ n: number }>(
      sql`select count(*)::int as n from sync_change`,
    );
    expect(after[0]?.n).toBe(before[0]?.n ?? -1);
  });
});

describe("notification_preference", () => {
  test("is unique per client, channel and category", async () => {
    const { client } = await seedAppointment();
    const row = { clientId: client.id, channel: "email" as const, category: "reminder" as const };
    await t.db.insert(notificationPreference).values({ ...row, enabled: false });
    const error = await t.db
      .insert(notificationPreference)
      .values({ ...row, enabled: true })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23505");
  });
});

describe("settings and locale columns", () => {
  test("salon settings default to 24h and 2h reminder leads", async () => {
    const [row] = await t.db
      .insert(salonSettings)
      .values({ name: "S", timezone: "UTC" })
      .returning();
    expect(row?.reminderFirstLeadMinutes).toBe(1440);
    expect(row?.reminderSecondLeadMinutes).toBe(120);
  });

  test("client profiles have a nullable locale", async () => {
    const [client] = await t.db.insert(clientProfile).values({ name: "L" }).returning();
    expect(client?.locale).toBeNull();
  });
});
