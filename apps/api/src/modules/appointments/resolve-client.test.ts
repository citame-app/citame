import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointmentSchema } from "@sob/contracts";
import { clientProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

// Inline ("walk-in") bookings match an existing profile by email or phone. A profile that has a
// login carries a phone anyone can type in (it is self-edited and never verified), so it must
// not be matchable by it: the booking would land on the account holder's profile.

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let account: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "resolve" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, account] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "client", "holder@example.com"),
  ]);
});

async function bookInline(client: Record<string, string>, startsAt = MONDAY_0900) {
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    { staffId: f.anaId, serviceIds: [f.haircutId], startsAt, client },
    owner.cookie,
  );
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json()).clientId;
}

describe("inline client matching", () => {
  test("does not attach a booking to a login-bearing profile by its self-edited phone", async () => {
    await t.db
      .update(clientProfile)
      .set({ phone: "+54 11 5555 0000" })
      .where(eq(clientProfile.id, account.clientId as string));
    const clientId = await bookInline({ name: "Someone Else", phone: "+54 11 5555 0000" });
    expect(clientId).not.toBe(account.clientId as string);
  });

  test("does not attach a booking by an email the login has not verified", async () => {
    await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, account.userId));
    const clientId = await bookInline({ name: "Someone Else", email: "holder@example.com" });
    expect(clientId).not.toBe(account.clientId as string);
  });

  test("matches a login-bearing profile by its exact, verified email", async () => {
    await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, account.userId));
    const clientId = await bookInline({ name: "Holder", email: "holder@example.com" });
    expect(clientId).toBe(account.clientId as string);
  });

  test("still reuses a walk-in profile (no login) by phone or email", async () => {
    const [walkIn] = await t.db
      .insert(clientProfile)
      .values({ name: "Walk In", phone: "1155550101", email: "walk@example.com" })
      .returning({ id: clientProfile.id });
    expect(await bookInline({ name: "Walk In", phone: "1155550101" })).toBe(walkIn?.id as string);
    expect(
      await bookInline({ name: "Walk In", email: "walk@example.com" }, "2026-03-09T14:00:00.000Z"),
    ).toBe(walkIn?.id as string);
  });

  test("with several matching walk-ins, the oldest one wins every time", async () => {
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-02-01T00:00:00Z");
    const [first] = await t.db
      .insert(clientProfile)
      .values({ name: "Dup New", phone: "1155550102", createdAt: newer })
      .returning({ id: clientProfile.id });
    const [second] = await t.db
      .insert(clientProfile)
      .values({ name: "Dup Old", phone: "1155550102", createdAt: older })
      .returning({ id: clientProfile.id });
    expect(first?.id).not.toBe(second?.id);
    expect(await bookInline({ name: "Dup", phone: "1155550102" })).toBe(second?.id as string);
  });
});
