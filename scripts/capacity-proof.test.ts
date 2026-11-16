import { afterAll, beforeAll, expect, test } from "bun:test";
import { appointment, clientProfile, staffProfile } from "../packages/db/src";
import { createTestDatabase, type TestDatabase } from "../packages/db/src/testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase("capacity_proof");
  await t.reset();
});
afterAll(async () => {
  await t.close();
});
test("the actual contention proof accepts legitimate parallel client spans and checks active work units", async () => {
  const [staff] = await t.db
    .insert(staffProfile)
    .values({ displayName: "Fixture parallel professional", maxConcurrent: 2 })
    .returning();
  const [client] = await t.db
    .insert(clientProfile)
    .values({ name: "Fixture proof client" })
    .returning();
  if (!staff || !client) throw new Error("Missing fixture");
  const visit = {
    staffId: staff.id,
    clientId: client.id,
    startsAt: new Date("2026-03-09T12:00:00Z"),
    endsAt: new Date("2026-03-09T13:00:00Z"),
  };
  await t.db.insert(appointment).values(visit);
  await t.db.insert(appointment).values(visit);
  const result = Bun.spawnSync(["bun", "k6/check-overlaps.ts"], {
    env: { ...process.env, DATABASE_URL: t.url },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString() + result.stdout.toString()).toBe(0);
  const report = JSON.parse(result.stdout.toString().split("\n")[0] ?? "{}");
  expect(report).toMatchObject({
    liveAppointments: 2,
    overlappingPairs: 0,
    appointmentSpanOverlaps: 1,
    capacityLimitViolations: 0,
  });
});
