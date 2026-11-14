import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { reminder } from "@sob/db";
import { eq } from "drizzle-orm";
import { actor, type Fixtures, MONDAY_0900, seedFixtures, setupApiTest } from "../../test/helpers";
import { loadConfig } from "../config";
import { createAppointment } from "../modules/appointments/service";
import { startNotificationRuntime } from "./runtime";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "notify_runtime" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
});

const envFor = (flag: string) =>
  loadConfig({
    BETTER_AUTH_SECRET: "x".repeat(32),
    NOTIFY_WORKER_ENABLED: flag,
    NOTIFY_POLL_INTERVAL_MS: "20",
  });

test("does nothing while the feature flag is off", async () => {
  expect(startNotificationRuntime({ db: t.db, config: envFor("false") })).toBeNull();
});

test("when enabled it polls the queue and stops gracefully", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const past = new Date("2026-03-01T00:00:00Z");
  await createAppointment(
    t.db,
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      client: { name: "L", email: "l@example.com" },
    },
    { userId: owner.userId },
    { now: past },
  );
  const runtime = startNotificationRuntime({ db: t.db, config: envFor("true"), log: () => {} });
  expect(runtime).not.toBeNull();
  // The confirmation is due immediately; with no email provider configured it is skipped.
  for (let i = 0; i < 50; i++) {
    const [row] = await t.db.select().from(reminder).where(eq(reminder.kind, "confirmation"));
    if (row?.status === "skipped") break;
    await Bun.sleep(50);
  }
  await runtime?.stop();
  const [row] = await t.db.select().from(reminder).where(eq(reminder.kind, "confirmation"));
  expect(row?.status).toBe("skipped");
  expect(row?.lastError).toBe("channel_disabled");
});
