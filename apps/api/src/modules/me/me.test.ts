import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { errorResponseSchema, meResponseSchema, salonResponseSchema } from "@sob/contracts";
import { clientProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import { type Actor, actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let client: Actor;
let owner: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  await seedFixtures(t.db);
  [client, owner] = await Promise.all([
    actor(t, "client", "lucia@example.com"),
    actor(t, "owner", "owner@example.com"),
  ]);
});

describe("GET /salon", () => {
  test("is public and returns the salon name, timezone and booking window", async () => {
    const res = await json(t.app, "/salon", "GET");
    expect(res.status).toBe(200);
    const body = salonResponseSchema.parse(await res.json());
    expect(body).toEqual({
      name: "Test Salon",
      timezone: "America/Argentina/Buenos_Aires",
      slotGranularityMinutes: 30,
      minNoticeMinutes: 60,
      maxDaysAhead: 90,
    });
  });
});

describe("PATCH /me", () => {
  test("a client updates name and phone, visible on /me and on the booking profile", async () => {
    const res = await json(
      t.app,
      "/me",
      "PATCH",
      { name: "Lucia Perez", phone: "+54 9 11 5555-0000" },
      client.cookie,
    );
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(await res.json());
    expect(me.user.name).toBe("Lucia Perez");
    expect(me.phone).toBe("+54 9 11 5555-0000");

    const again = meResponseSchema.parse(
      await (await json(t.app, "/me", "GET", undefined, client.cookie)).json(),
    );
    expect(again.user.name).toBe("Lucia Perez");
    expect(again.phone).toBe("+54 9 11 5555-0000");

    const [profile] = await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, client.clientId as string));
    expect(profile?.name).toBe("Lucia Perez");
    expect(profile?.phone).toBe("+54 9 11 5555-0000");
  });

  test("a null phone clears it", async () => {
    await json(t.app, "/me", "PATCH", { phone: "+54 11 5555 0000" }, client.cookie);
    const res = await json(t.app, "/me", "PATCH", { phone: null }, client.cookie);
    expect(meResponseSchema.parse(await res.json()).phone).toBeNull();
  });

  test("anonymous callers get 401 and invalid bodies get 400", async () => {
    expect((await json(t.app, "/me", "PATCH", { name: "X" })).status).toBe(401);
    const bad = await json(t.app, "/me", "PATCH", { name: "" }, client.cookie);
    expect(bad.status).toBe(400);
    expect(errorResponseSchema.parse(await bad.json()).error.code).toBe("validation_error");
  });

  test("an account without a booking profile cannot store a phone", async () => {
    const res = await json(t.app, "/me", "PATCH", { phone: "+54 11 5555 0000" }, owner.cookie);
    expect(res.status).toBe(400);
    const ok = await json(t.app, "/me", "PATCH", { name: "The Owner" }, owner.cookie);
    expect(ok.status).toBe(200);
    expect(meResponseSchema.parse(await ok.json()).user.name).toBe("The Owner");
  });
});
