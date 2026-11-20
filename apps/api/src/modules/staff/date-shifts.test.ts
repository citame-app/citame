import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  dateShiftPreviewSchema,
  dateShiftsResponseSchema,
  teamShiftWeekSchema,
} from "@sob/contracts";
import { appointment, dateShift, dateShiftBatch, salonSettings } from "@sob/db";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { pullAll } from "../../../test/sync";
import { runWaitlist } from "../waitlist/matching";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "date_shifts" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "shifts-owner@example.invalid");
});
const call = (path: string, method = "GET", body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
const base = () => `/admin/staff/${f.anaId}/date-shifts`;
const edit = (date: string, ranges: { startTime: string; endTime: string }[] | null) => ({
  mode: "edit",
  changes: [{ date, ranges }],
});
async function preview(selection: unknown) {
  const response = await call(`${base()}/preview`, "POST", selection);
  expect(response.status, await response.clone().text()).toBe(200);
  return dateShiftPreviewSchema.parse(await response.json());
}
async function save(selection: unknown) {
  const review = await preview(selection);
  const input = { selection, reviewHash: review.reviewHash, idempotencyKey: crypto.randomUUID() };
  const response = await call(base(), "POST", input);
  expect(response.status, await response.clone().text()).toBe(201);
  return { input, response };
}
test("the team week shows dated hours and clips absences without exposing personal reasons", async () => {
  const week = "/admin/staff/team-shifts?week=2026-03-09";
  await save(edit("2026-03-09", [{ startTime: "12:00", endTime: "14:00" }]));
  const absence = await call(`/admin/staff/${f.anaId}/time-off`, "POST", {
    startsAt: "2026-03-10T02:00:00.000Z",
    endsAt: "2026-03-11T03:00:00.000Z",
    reason: "Private absence reason",
  });
  expect(absence.status, await absence.clone().text()).toBe(201);
  const result = await call(week);
  expect(result.status, await result.clone().text()).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  const raw = await result.json();
  const body = teamShiftWeekSchema.parse(raw);
  expect(body.members.map((member) => member.id)).toContain(f.anaId);
  expect(body.members.find((member) => member.id === f.anaId)?.days.slice(0, 2)).toMatchObject([
    {
      date: "2026-03-09",
      custom: true,
      ranges: [{ startTime: "12:00", endTime: "14:00" }],
      absences: [
        {
          fullDay: false,
          startsAt: "2026-03-10T02:00:00.000Z",
          endsAt: "2026-03-10T03:00:00.000Z",
        },
      ],
    },
    { date: "2026-03-10", custom: false, absences: [{ fullDay: true }] },
  ]);
  expect(JSON.stringify(raw)).not.toContain("Private absence reason");
  expect((await call("/admin/staff/team-shifts?week=2026-03-10")).status).toBe(400);
  expect((await call("/admin/staff/team-shifts?week=9999-12-27")).status).toBe(400);
  const professional = await actor(t, "staff", "team-week-staff@example.invalid", {
    staffProfileId: f.anaId,
  });
  expect((await call(week, "GET", undefined, professional)).status).toBe(403);
});
test("a custom dated shift closes or opens only that date for availability and every booking path", async () => {
  const selection = edit("2026-03-09", [{ startTime: "12:00", endTime: "14:00" }]);
  await save(selection);
  const available = await call(
    `/availability?date=2026-03-09&staffId=${f.anaId}&serviceIds=${f.haircutId}`,
  );
  const slots = ((await available.json()) as { slots: { startsAt: string }[] }).slots;
  expect(slots[0]?.startsAt).toBe("2026-03-09T15:00:00.000Z");
  const booking = {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    override: true,
  };
  expect((await call("/appointments", "POST", booking)).status).toBe(409);
  expect(
    (await call("/appointments", "POST", { ...booking, startsAt: "2026-03-09T15:00:00.000Z" }))
      .status,
  ).toBe(201);
  expect(
    (await call("/appointments", "POST", { ...booking, startsAt: "2026-03-16T12:00:00.000Z" }))
      .status,
  ).toBe(201);
  await save(edit("2026-03-14", [{ startTime: "09:00", endTime: "12:00" }]));
  expect(
    (await call("/appointments", "POST", { ...booking, startsAt: "2026-03-14T12:00:00.000Z" }))
      .status,
  ).toBe(201);
});
test("the review lists existing conflicts and committing never moves or cancels those visits", async () => {
  const booked = await call("/appointments", "POST", {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
  });
  expect(booked.status).toBe(201);
  const before = await t.db.select().from(appointment);
  const selection = edit("2026-03-09", []);
  const review = await preview(selection);
  expect(review.conflicts).toHaveLength(1);
  await save(selection);
  expect(await t.db.select().from(appointment)).toEqual(before);
  const hours = await call(`/admin/staff/${f.anaId}/working-hours`);
  expect(((await hours.json()) as { conflicts: unknown[] }).conflicts).toHaveLength(1);
});
test("copying freezes the reviewed effective source days and a changed source invalidates the preview", async () => {
  await save(edit("2026-03-09", [{ startTime: "12:00", endTime: "14:00" }]));
  const selection = {
    mode: "copy",
    sourceFrom: "2026-03-09",
    days: 7,
    targetStarts: ["2026-03-16"],
  };
  const old = await preview(selection);
  expect(old.changes[0]?.next.effectiveRanges).toEqual([{ startTime: "12:00", endTime: "14:00" }]);
  expect(old.changes[6]?.next.effectiveRanges).toEqual([]);
  await save(edit("2026-03-09", [{ startTime: "13:00", endTime: "15:00" }]));
  expect(
    (
      await call(base(), "POST", {
        selection,
        reviewHash: old.reviewHash,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  const saved = await save(selection);
  expect((await call(base(), "POST", saved.input)).status).toBe(201);
  const listing = await call(`${base()}?from=2026-03-16&to=2026-03-22`);
  expect(
    ((await listing.json()) as { days: { effectiveRanges: unknown[] }[] }).days[0]?.effectiveRanges,
  ).toEqual([{ startTime: "13:00", endTime: "15:00" }]);
});
test("restoring a date to weekly hours keeps a revision fence and permissions match schedule administration", async () => {
  await save(edit("2026-03-09", []));
  await save(edit("2026-03-09", null));
  const listing = await call(`${base()}?from=2026-03-09&to=2026-03-09`);
  expect(await listing.json()).toMatchObject({
    days: [
      {
        date: "2026-03-09",
        version: 2,
        ranges: null,
        effectiveRanges: [{ startTime: "09:00", endTime: "18:00" }],
      },
    ],
  });
  const customer = await actor(t, "client", "shift-client@example.invalid");
  expect(
    (await call(`${base()}?from=2026-03-09&to=2026-03-09`, "GET", undefined, customer)).status,
  ).toBe(403);
  const professional = await actor(t, "staff", "shift-professional@example.invalid", {
    staffProfileId: f.anaId,
  });
  expect(
    (await call(`${base()}?from=2026-03-09&to=2026-03-09`, "GET", undefined, professional)).status,
  ).toBe(200);
  expect(
    (await call(`${base()}/preview`, "POST", edit("2026-03-09", []), professional)).status,
  ).toBe(403);
});
test("a specific date rejects nonexistent local times at the daylight-saving transition", async () => {
  await t.db.update(salonSettings).set({ timezone: "Europe/Madrid" });
  const response = await call(
    `${base()}/preview`,
    "POST",
    edit("2026-03-29", [{ startTime: "02:30", endTime: "04:00" }]),
  );
  expect(response.status).toBe(400);
});

test("a booking created after review invalidates the batch without moving it or silently applying a new closure", async () => {
  const selection = edit("2026-03-09", []);
  const reviewed = await preview(selection);
  expect(reviewed.conflicts).toHaveLength(0);
  expect(
    (
      await call("/appointments", "POST", {
        staffId: f.anaId,
        clientId: f.clientId,
        serviceIds: [f.haircutId],
        startsAt: "2026-03-09T12:00:00.000Z",
      })
    ).status,
  ).toBe(201);
  const stale = await call(base(), "POST", {
    selection,
    reviewHash: reviewed.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(stale.status).toBe(409);
  expect(await t.db.select().from(dateShift)).toHaveLength(0);
  expect(await t.db.select().from(dateShiftBatch)).toHaveLength(0);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});

test("a lost apply response can replay after a colleague edits the date without overwriting the newer hours", async () => {
  const original = await save(edit("2026-03-09", []));
  await save(edit("2026-03-09", [{ startTime: "12:00", endTime: "14:00" }]));
  const replay = await call(base(), "POST", original.input);
  expect(replay.status).toBe(201);
  expect(await replay.json()).toMatchObject({
    replayed: true,
    days: [{ version: 2, ranges: [{ startTime: "12:00", endTime: "14:00" }] }],
  });
  expect(await t.db.select().from(dateShiftBatch)).toHaveLength(2);
});

test("closing an offered date expires the hold without an entry-lock inversion and releases it for other professionals", async () => {
  const room = await call("/admin/resources", "POST", {
    name: "Shared room",
    kind: "room",
    capacity: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  const pool = (await room.json()) as { id: string };
  expect(
    (
      await call(`/admin/services/${f.haircutId}/resources`, "PUT", {
        version: 1,
        requirements: [{ resourceId: pool.id, quantity: 1 }],
      })
    ).status,
  ).toBe(200);
  expect(
    (await call("/admin/waitlist/policy", "PUT", { version: 1, enabled: true, offerMinutes: 30 }))
      .status,
  ).toBe(200);
  const client = await actor(t, "client", "shifts-waiting@example.invalid");
  expect(
    (
      await call(
        "/me/waitlist",
        "POST",
        {
          staffId: f.anaId,
          serviceIds: [f.haircutId],
          fromDate: "2026-03-09",
          toDate: "2026-03-09",
          fromTime: "09:00",
          toTime: "10:00",
          idempotencyKey: crypto.randomUUID(),
        },
        client,
      )
    ).status,
  ).toBe(201);
  await runWaitlist(t.db, { now: NOW });
  const selection = edit("2026-03-09", []);
  const reviewed = await preview(selection);
  expect(reviewed.withdrawnOffers).toBe(1);
  expect(
    (
      await call(base(), "POST", {
        selection,
        reviewHash: reviewed.reviewHash,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await call("/appointments", "POST", {
        staffId: f.beaId,
        clientId: f.clientId,
        serviceIds: [f.haircutId],
        startsAt: "2026-03-09T12:00:00.000Z",
      })
    ).status,
  ).toBe(201);
  await runWaitlist(t.db, { now: NOW });
  const queue = await call("/me/waitlist", "GET", undefined, client);
  expect(await queue.json()).toMatchObject({ entries: [{ state: "waiting", offer: null }] });
});

test("dated shifts reach only the permitted calendars in sync and preserve explicit weekly restoration", async () => {
  await save(edit("2026-03-09", []));
  const professional = await actor(t, "staff", "shifts-sync@example.invalid", {
    staffProfileId: f.anaId,
  });
  let page = await pullAll(t, professional);
  expect(
    page.changes.filter((change) => change.entity === "date_shift" && change.op === "upsert"),
  ).toMatchObject([{ data: { staffId: f.anaId, date: "2026-03-09", ranges: [], version: 1 } }]);
  await save(edit("2026-03-09", null));
  page = await pullAll(t, professional, page.cursor);
  expect(
    page.changes.filter((change) => change.entity === "date_shift" && change.op === "upsert"),
  ).toMatchObject([{ data: { ranges: null, version: 2 } }]);
});

test("large inherited weekly templates remain readable but cannot silently exceed the custom-date range limit when copied", async () => {
  const ranges = Array.from({ length: 9 }, (_, index) => ({
    weekday: 1,
    startTime: `${String(index).padStart(2, "0")}:00`,
    endTime: `${String(index + 1).padStart(2, "0")}:00`,
  }));
  expect(
    (await call(`/admin/staff/${f.anaId}/working-hours`, "PUT", { hours: ranges })).status,
  ).toBe(200);
  const response = await call(`${base()}?from=2026-03-09&to=2026-03-09`);
  expect(
    dateShiftsResponseSchema.parse(await response.json()).days[0]?.effectiveRanges,
  ).toHaveLength(9);
  const copy = await call(`${base()}/preview`, "POST", {
    mode: "copy",
    sourceFrom: "2026-03-09",
    days: 1,
    targetStarts: ["2026-03-16"],
  });
  expect(copy.status).toBe(400);
  expect(await t.db.select().from(dateShift)).toHaveLength(0);
});
