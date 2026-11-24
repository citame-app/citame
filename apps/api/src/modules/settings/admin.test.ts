import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  availabilityResponseSchema,
  desktopSalonSettingsSchema,
  errorResponseSchema,
  profileMediaSnapshotSchema,
  publicBusinessProfileSchema,
  salonResponseSchema,
} from "@sob/contracts";
import { auditLog } from "@sob/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY,
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

const call = (who: Actor | null, method: string, body?: unknown) =>
  json(t.app, "/admin/settings", method, body, who?.cookie);
const code = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;

test("profile images stay private until both the image and profile are published", async () => {
  const media = "/admin/settings/profile/images";
  const publicMedia = "/salon/profile/images";
  const get = (who: Actor | null, path: string) => json(t.app, path, "GET", undefined, who?.cookie);
  const snapshot = profileMediaSnapshotSchema.parse(await (await get(owner, media)).json());
  const save = (base: typeof snapshot, action: unknown, who = owner) =>
    json(
      t.app,
      media,
      "PUT",
      { generation: base.generation, expectedRevision: base.revision, action },
      who.cookie,
    );
  const profile = async () =>
    publicBusinessProfileSchema.parse(await (await get(null, "/salon/profile")).json());
  const imageBase64 = (
    await sharp({
      create: { width: 24, height: 16, channels: 3, background: "#333333" },
    })
      .png()
      .toBuffer()
  ).toString("base64");
  const upload = { mode: "upload", kind: "cover", alt: "Centre entrance", imageBase64 };
  expect((await get(ana, media)).status).toBe(403);
  expect((await save(snapshot, upload, ana)).status).toBe(403);
  expect((await save({ ...snapshot, generation: "old-backup" }, upload)).status).toBe(409);
  const saved = await save(snapshot, upload);
  expect(saved.status, await saved.clone().text()).toBe(200);
  const draft = profileMediaSnapshotSchema.parse(await saved.json());
  const [cover] = draft.images;
  if (!cover) throw new Error("Missing cover");
  const url = (base: string, version: string) => `${base}/${cover.id}/${version}`;
  expect(cover).toMatchObject({ width: 24, height: 16, published: false });
  expect((await get(owner, url(media, cover.version))).headers.get("Content-Type")).toBe(
    "image/jpeg",
  );
  expect((await get(ana, url(media, cover.version))).status).toBe(403);
  expect((await get(null, url(publicMedia, cover.version))).status).toBe(404);
  expect((await save(snapshot, upload)).status).toBe(409);
  expect((await save(draft, upload)).status).toBe(400);
  const publication = { mode: "publication", id: cover.id, published: true };
  const published = profileMediaSnapshotSchema.parse(await (await save(draft, publication)).json());
  const current = published.images[0]?.version ?? "";
  expect(await profile()).toEqual({ profile: null });
  const unpublished = await get(null, url(publicMedia, current));
  expect(unpublished.status).toBe(404);
  expect(unpublished.headers.get("Cache-Control")).toBe("private, no-store");
  const writeProfile = (revision: string, published: boolean) =>
    json(
      t.app,
      "/admin/settings/profile",
      "PUT",
      { generation: snapshot.generation, expectedRevision: revision, changes: { published } },
      owner.cookie,
    );
  const profileWrite = await writeProfile(published.revision, true);
  expect(profileWrite.status).toBe(200);
  expect((await profile()).images).toEqual([
    {
      id: cover.id,
      kind: "cover",
      alt: "Centre entrance",
      width: 24,
      height: 16,
      version: current,
    },
  ]);
  const image = await get(null, url(publicMedia, current));
  expect(image.status).toBe(200);
  expect(image.headers.get("Cache-Control")).toBe("private, no-store");
  expect((await get(null, url(publicMedia, cover.version))).status).toBe(404);
  const { revision } = desktopSalonSettingsSchema.parse(await profileWrite.json());
  expect((await writeProfile(revision, false)).status).toBe(200);
  expect((await get(null, url(publicMedia, current))).status).toBe(404);
  expect((await save(published, { ...upload, replaceId: cover.id })).status).toBe(409);
  const latest = profileMediaSnapshotSchema.parse(await (await get(owner, media)).json());
  const replaced = profileMediaSnapshotSchema.parse(
    await (await save(latest, { ...upload, replaceId: cover.id })).json(),
  );
  expect(replaced.images[0]).toMatchObject({ id: cover.id, published: false });
  expect((await get(owner, url(media, current))).status).toBe(404);
  const removed = profileMediaSnapshotSchema.parse(
    await (await save(replaced, { mode: "remove", id: cover.id })).json(),
  );
  expect(removed.images).toEqual([]);
});

test("split opening hours and dated closures are published without changing bookable slots", async () => {
  const available = async () => {
    const result = await json(
      t.app,
      `/availability?serviceIds=${f.haircutId}&date=${MONDAY}`,
      "GET",
    );
    expect(result.status).toBe(200);
    return availabilityResponseSchema.parse(await result.json());
  };
  const before = await available();
  expect(before.slots.length).toBeGreaterThan(0);
  const latest = desktopSalonSettingsSchema.parse(
    await (await json(t.app, "/admin/settings/desktop", "GET", undefined, owner.cookie)).json(),
  );
  const morning = { startTime: "09:00", endTime: "12:00" };
  const afternoon = { startTime: "14:00", endTime: "18:00" };
  const weekly = [[], [afternoon, morning], [], [], [], [], []];
  const exception = { date: MONDAY, ranges: [] };
  const update = (expectedRevision: string, changes: unknown) =>
    json(
      t.app,
      "/admin/settings/profile",
      "PUT",
      {
        generation: latest.generation,
        expectedRevision,
        changes,
      },
      owner.cookie,
    );
  const save = (openingSchedule: unknown, published: boolean) =>
    update(latest.revision, { openingSchedule, published });
  expect((await save({ weekly, exceptions: [exception, exception] }, true)).status).toBe(400);
  expect(
    (
      await save(
        {
          weekly: [[], [morning, { startTime: "11:00", endTime: "13:00" }], [], [], [], [], []],
          exceptions: [],
        },
        true,
      )
    ).status,
  ).toBe(400);
  const result = await save({ weekly, exceptions: [exception] }, true);
  expect(result.status, await result.clone().text()).toBe(200);
  const publicData = publicBusinessProfileSchema.parse(
    await (await json(t.app, "/salon/profile", "GET")).json(),
  );
  expect(publicData.profile).not.toHaveProperty("openingSchedule");
  expect(publicData.openingSchedule).toEqual({
    weekly: [[], [morning, afternoon], [], [], [], [], []],
    exceptions: [exception],
  });
  const first = desktopSalonSettingsSchema.parse(await result.json());
  expect(first.businessProfile).not.toHaveProperty("openingSchedule");
  const closeLater = { openingScheduleEdits: { exceptions: { "2026-12-25": [] } } };
  const changeMonday = { openingScheduleEdits: { days: { "1": [morning] } } };
  const remote = await update(first.revision, closeLater);
  expect(remote.status, await remote.clone().text()).toBe(200);
  expect((await update(first.revision, changeMonday)).status).toBe(409);
  const rebased = await update(
    desktopSalonSettingsSchema.parse(await remote.json()).revision,
    changeMonday,
  );
  expect(rebased.status, await rebased.clone().text()).toBe(200);
  expect(desktopSalonSettingsSchema.parse(await rebased.json()).openingSchedule).toEqual({
    weekly: [[], [morning], [], [], [], [], []],
    exceptions: [exception, { date: "2026-12-25", ranges: [] }].sort((a, b) =>
      a.date.localeCompare(b.date),
    ),
  });
  expect(await available()).toEqual(before);
});

test("keeps the public profile draft private and publishes only reviewed owner changes", async () => {
  const read = (who: Actor) => json(t.app, "/admin/settings/desktop", "GET", undefined, who.cookie);
  const write = (who: Actor, body: unknown) =>
    json(t.app, "/admin/settings/profile", "PUT", body, who.cookie);
  const publicProfile = async () => {
    const response = await json(t.app, "/salon/profile", "GET");
    expect(response.headers.get("cache-control")).toBe("no-store");
    return publicBusinessProfileSchema.parse(await response.json()).profile;
  };
  const initial = desktopSalonSettingsSchema.parse(await (await read(owner)).json());
  expect(initial.businessProfile).toMatchObject({ published: false, address: null });
  expect(await publicProfile()).toBeNull();
  expect((await read(ana)).status).toBe(403);
  expect((await write(ana, {})).status).toBe(403);
  expect((await call(client, "PATCH", { businessProfile: { published: true } })).status).toBe(403);
  expect((await call(owner, "PATCH", { businessProfile: { published: true } })).status).toBe(400);
  expect(
    (
      await json(
        t.app,
        "/admin/settings/desktop",
        "PUT",
        {
          expectedRevision: initial.revision,
          changes: { businessProfile: { published: true } },
        },
        owner.cookie,
      )
    ).status,
  ).toBe(409);

  const fence = { generation: initial.generation, expectedRevision: initial.revision };
  expect(
    (await write(owner, { ...fence, generation: "older-generation", changes: { published: true } }))
      .status,
  ).toBe(409);
  for (const website of [
    "javascript:alert(1)",
    "http://example.test",
    "https://user@example.test",
  ]) {
    expect((await write(owner, { ...fence, changes: { website } })).status).toBe(400);
  }
  const firstLine = "Synthetic salon profile";
  const description = [firstLine, "Treatment and opening details. ".repeat(39).trim()].join("\n\n");
  for (const invalid of [
    "x".repeat(2001),
    "x\u0000y",
    "x\uD800y",
    "x\n".repeat(64) + "last line",
  ]) {
    expect((await write(owner, { ...fence, changes: { description: invalid } })).status).toBe(400);
  }
  const draft = await write(owner, {
    ...fence,
    changes: {
      description: description.replaceAll("\n", "\r\n"),
      amenities: ["wifi", "wifi"],
      website: "https://example.test",
    },
  });
  expect(draft.status, await draft.clone().text()).toBe(200);
  expect(await draft.json()).toMatchObject({
    businessProfile: { published: false, description, amenities: ["wifi"] },
  });
  expect(await publicProfile()).toBeNull();
  const staffSync = await json(t.app, "/sync/pull?since=0&limit=200", "GET", undefined, ana.cookie);
  expect(staffSync.status).toBe(200);
  expect(await staffSync.text()).not.toContain(firstLine);
  expect((await write(owner, { ...fence, changes: { published: true } })).status).toBe(409);
  const latest = desktopSalonSettingsSchema.parse(await (await read(owner)).json());
  expect(
    (
      await write(owner, {
        ...fence,
        expectedRevision: latest.revision,
        changes: { published: true, address: "7 Test Street" },
      })
    ).status,
  ).toBe(200);
  expect(await publicProfile()).toMatchObject({
    description,
    address: "7 Test Street",
    amenities: ["wifi"],
    website: "https://example.test",
  });
  expect(await publicProfile()).not.toHaveProperty("published");
  const published = desktopSalonSettingsSchema.parse(await (await read(owner)).json());
  expect(
    (
      await write(owner, {
        ...fence,
        expectedRevision: published.revision,
        changes: { published: false },
      })
    ).status,
  ).toBe(200);
  expect(await publicProfile()).toBeNull();
  expect(await (await read(owner)).json()).toMatchObject({ businessProfile: { description } });
});

describe("access control", () => {
  test("anonymous is 401; staff and clients are 403 and nothing changes", async () => {
    expect((await call(null, "PATCH", { name: "x" })).status).toBe(401);
    for (const who of [ana, client]) {
      const res = await call(who, "PATCH", { name: "Hacked" });
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
    }
    const salon = salonResponseSchema.parse(await (await json(t.app, "/salon", "GET")).json());
    expect(salon.name).toBe("Test Salon");
  });
});

describe("PATCH /admin/settings", () => {
  test("pausing online booking preserves committed requests and staff can still book", async () => {
    const request = {
      id: crypto.randomUUID(),
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
    };
    const book = (who: Actor, body: unknown) =>
      json(t.app, "/appointments", "POST", body, who.cookie);
    const created = await book(client, request);
    expect(created.status).toBe(201);
    const pause = await call(owner, "PATCH", { onlineBookingEnabled: false });
    expect(pause.status).toBe(200);
    const salon = await json(t.app, "/salon", "GET");
    expect(await salon.json()).toMatchObject({ onlineBookingEnabled: false });
    const replay = await book(client, request);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("x-idempotent-replay")).toBe("true");
    const existing = await json(
      t.app,
      "/appointments?from=2026-03-09T00:00:00.000Z&to=2026-03-10T00:00:00.000Z",
      "GET",
      undefined,
      client.cookie,
    );
    expect(await existing.json()).toMatchObject({ appointments: [{ id: request.id }] });

    const next = { ...request, id: crypto.randomUUID(), startsAt: "2026-03-09T14:00:00.000Z" };
    const blocked = await book(client, next);
    expect(blocked.status).toBe(409);
    expect(await code(blocked)).toBe("online_booking_paused");
    expect((await book(owner, { ...next, clientId: f.clientId })).status).toBe(201);
    expect((await call(owner, "PATCH", { onlineBookingEnabled: true })).status).toBe(200);
    expect(
      (
        await book(client, {
          ...next,
          id: crypto.randomUUID(),
          startsAt: "2026-03-09T16:00:00.000Z",
        })
      ).status,
    ).toBe(201);
  });

  test("the owner edits settings; the public salon endpoint reflects it at once", async () => {
    const res = await call(owner, "PATCH", {
      name: "Studio Rosa",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
    });
    expect(res.status).toBe(200);
    const body = salonResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      name: "Studio Rosa",
      timezone: "America/Argentina/Buenos_Aires",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 120,
      maxDaysAhead: 30,
    });
    const publicSalon = salonResponseSchema.parse(
      await (await json(t.app, "/salon", "GET")).json(),
    );
    expect(publicSalon).toEqual(body);
  });

  test("rejects invalid values with validation_error and changes nothing", async () => {
    for (const bad of [
      {},
      { timezone: "Mars/Olympus" },
      { slotGranularityMinutes: 7 },
      { maxDaysAhead: 0 },
    ]) {
      const res = await call(owner, "PATCH", bad);
      expect([JSON.stringify(bad), res.status]).toEqual([JSON.stringify(bad), 400]);
      expect(await code(res)).toBe("validation_error");
    }
    expect(await (await call(owner, "GET")).json()).toMatchObject({ name: "Test Salon" });
  });

  test("audits changed field names only, and skips no-op edits", async () => {
    await call(owner, "PATCH", { name: "Studio Rosa", maxDaysAhead: 90 });
    await call(owner, "PATCH", { name: "Studio Rosa" }); // unchanged
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "settings.update"));
    expect(rows.length).toBe(1);
    expect(rows[0]?.metadata).toEqual({ fields: ["name"] });
  });

  test("the owner can read the settings", async () => {
    const res = await call(owner, "GET");
    expect(res.status).toBe(200);
    expect(salonResponseSchema.parse(await res.json()).name).toBe("Test Salon");
  });
});
