import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  adminStaffSchema,
  appointmentSchema,
  errorResponseSchema,
  listAdminStaffResponseSchema,
  listStaffResponseSchema,
  listTimeOffResponseSchema,
  staffPortraitResultSchema,
  timeOffResponseSchema,
  workingHoursResponseSchema,
} from "@sob/contracts";
import { appointment, auditLog, timeOff, user, workingHours } from "@sob/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
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
let bea: Actor;
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
  [owner, ana, bea, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "ana@example.com", { staffProfileId: f.anaId }),
    actor(t, "staff", "bea@example.com", { staffProfileId: f.beaId }),
    actor(t, "client", "c@example.com"),
  ]);
});

const call = (who: Actor | null, method: string, path: string, body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const errorCode = async (res: Response) => errorResponseSchema.parse(await res.json()).error.code;
const audit = (action: string) =>
  t.db.select().from(auditLog).where(eq(auditLog.action, action)).orderBy(asc(auditLog.createdAt));

async function bookAna(startsAt = MONDAY_0900, staffId = f.anaId) {
  const res = await call(owner, "POST", "/appointments", {
    staffId,
    serviceIds: [f.haircutId],
    startsAt,
    clientId: f.clientId,
  });
  expect(res.status).toBe(201);
  return appointmentSchema.parse(await res.json());
}

const hours = (...ranges: [number, string, string][]) => ({
  hours: ranges.map(([weekday, startTime, endTime]) => ({ weekday, startTime, endTime })),
});

test("manages one private portrait per member with revision and access checks", async () => {
  const source = await sharp({
    create: { width: 256, height: 192, channels: 3, background: "#87556a" },
  })
    .png()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const path = `/admin/staff/${f.anaId}/portrait`;
  const input = { version: null, imageBase64: source.toString("base64") };
  expect((await call(ana, "PUT", path, input)).status).toBe(403);
  const result = await call(owner, "PUT", path, input);
  expect(result.status).toBe(200);
  const { version } = staffPortraitResultSchema.parse(await result.json());
  if (!version) throw new Error("Portrait creation returned no version");
  expect((await call(owner, "PUT", path, input)).status).toBe(409);

  expect((await call(null, "GET", path)).status).toBe(401);
  expect((await call(client, "GET", path)).status).toBe(403);
  expect((await call(bea, "GET", path)).status).toBe(403);
  expect((await call(ana, "GET", `${path}?v=${crypto.randomUUID()}`)).status).toBe(404);
  expect((await call(ana, "GET", `${path}?v=${version}`)).status).toBe(200);
  const portrait = await call(ana, "GET", path);
  expect(portrait.headers.get("cache-control")).toBe("private, no-store");
  expect(portrait.headers.get("content-type")).toBe("image/jpeg");
  const metadata = await sharp(Buffer.from(await portrait.arrayBuffer())).metadata();
  expect(metadata).toMatchObject({ format: "jpeg", width: 192, height: 256 });
  expect(metadata.exif).toBeUndefined();
  const { staff, canEditPortraits } = listAdminStaffResponseSchema.parse(
    await (await call(owner, "GET", "/admin/staff")).json(),
  );
  expect(canEditPortraits).toBe(true);
  expect(
    listAdminStaffResponseSchema.parse(await (await call(ana, "GET", "/admin/staff")).json())
      .canEditPortraits,
  ).toBe(false);
  expect(staff.find((member) => member.id === f.anaId)?.portraitVersion).toBe(version);

  const remove = await call(owner, "PUT", path, { version, imageBase64: null });
  expect(await remove.json()).toEqual({ version: null });
  expect((await call(owner, "GET", path)).status).toBe(404);
  expect((await call(owner, "PUT", path, input)).status).toBe(409);
  const absence = listAdminStaffResponseSchema
    .parse(await (await call(owner, "GET", "/admin/staff")).json())
    .staff.find((member) => member.id === f.anaId);
  expect(absence?.portraitVersion).toBeUndefined();
  const absenceVersion = absence?.portraitAbsenceVersion;
  if (!absenceVersion) throw new Error("Removal returned no absence fence in the directory");
  expect(absenceVersion).not.toBe(version);
  const publicList = await (await call(null, "GET", "/staff")).text();
  expect(publicList).not.toContain(absenceVersion);
  expect(
    (await call(owner, "PUT", `${path}/publication`, { version: absenceVersion, published: true }))
      .status,
  ).toBe(404);
  const uploaded = await call(owner, "PUT", path, { ...input, version: absenceVersion });
  expect(uploaded.status).toBe(200);
  const newVersion = staffPortraitResultSchema.parse(await uploaded.json()).version;
  expect(newVersion).toBeTruthy();
  expect((await call(owner, "PUT", path, { version: newVersion, imageBase64: null })).status).toBe(
    200,
  );
  expect((await call(owner, "PUT", path, { ...input, version: absenceVersion })).status).toBe(409);
});

test("the desktop portrait directory uses the same permissions as the staff directory", async () => {
  for (const who of [owner, ana, client, null]) {
    const canonical = await call(who, "GET", "/admin/staff");
    const desktop = await call(who, "GET", "/admin/staff/portrait-directory");
    expect(desktop.status).toBe(canonical.status);
    if (desktop.ok) {
      expect(desktop.headers.get("cache-control")).toBe("private, no-store");
      expect(listAdminStaffResponseSchema.parse(await desktop.json())).toEqual(
        listAdminStaffResponseSchema.parse(await canonical.json()),
      );
    }
  }
});

test("public portrait access requires a current publication on an active member", async () => {
  const imageBase64 = (
    await sharp({ create: { width: 40, height: 40, channels: 3, background: "#87556a" } })
      .jpeg()
      .toBuffer()
  ).toString("base64");
  const route = `/admin/staff/${f.anaId}/portrait`;
  const publicImage = (version: string) =>
    call(null, "GET", `/staff/${f.anaId}/portrait/${version}`);
  const publicMember = async () => {
    const response = await call(null, "GET", "/staff");
    return listStaffResponseSchema
      .parse(await response.json())
      .staff.find(({ id }) => id === f.anaId);
  };
  const savedVersion = async (response: Response) => {
    expect(response.status).toBe(200);
    const { version } = staffPortraitResultSchema.parse(await response.json());
    if (!version) throw new Error("Missing portrait version");
    return version;
  };
  const publish = (version: string, published: boolean) =>
    call(owner, "PUT", `${route}/publication`, { version, published });

  const internal = await savedVersion(
    await call(owner, "PUT", route, { imageBase64, version: null }),
  );
  expect((await publicMember())?.portraitVersion).toBeUndefined();
  expect((await publicImage(internal)).status).toBe(404);
  expect(
    (await call(ana, "PUT", `${route}/publication`, { version: internal, published: true })).status,
  ).toBe(403);
  const published = await savedVersion(await publish(internal, true));
  expect(await publicMember()).toMatchObject({ portraitVersion: published });
  const image = await publicImage(published);
  expect(image.status).toBe(200);
  expect(image.headers.get("cache-control")).toContain("no-store");
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect((await publicImage(internal)).status).toBe(404);
  expect((await publish(internal, false)).status).toBe(409);

  expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: false })).status).toBe(
    200,
  );
  expect((await publicImage(published)).status).toBe(404);
  expect(await publicMember()).toBeUndefined();
  expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: true })).status).toBe(
    200,
  );

  const nextInternal = await savedVersion(
    await call(owner, "PUT", route, {
      imageBase64,
      version: published,
    }),
  );
  expect((await publicImage(published)).status).toBe(404);
  expect((await publicImage(nextInternal)).status).toBe(404);
  const nextPublic = await savedVersion(await publish(nextInternal, true));
  const withdrawn = await savedVersion(await publish(nextPublic, false));
  expect((await publicImage(nextPublic)).status).toBe(404);
  expect((await publicImage(withdrawn)).status).toBe(404);
  expect((await call(owner, "GET", route)).status).toBe(200);
});

describe("access control", () => {
  test("anonymous callers get 401 and clients get 403 on every staff admin endpoint", async () => {
    const cases: [string, string, unknown][] = [
      ["GET", "/admin/staff", undefined],
      ["PATCH", `/admin/staff/${f.anaId}`, { displayName: "x" }],
      ["GET", `/admin/staff/${f.anaId}/working-hours`, undefined],
      ["PUT", `/admin/staff/${f.anaId}/working-hours`, hours()],
      ["GET", `/admin/staff/${f.anaId}/time-off`, undefined],
      [
        "POST",
        `/admin/staff/${f.anaId}/time-off`,
        { startsAt: "2026-03-10T12:00:00Z", endsAt: "2026-03-10T14:00:00Z" },
      ],
      ["PATCH", `/admin/staff/${f.anaId}/time-off/${Bun.randomUUIDv7()}`, { reason: "x" }],
      ["DELETE", `/admin/staff/${f.anaId}/time-off/${Bun.randomUUIDv7()}`, undefined],
    ];
    for (const [method, path, body] of cases) {
      expect([path, (await call(null, method, path, body)).status]).toEqual([path, 401]);
      expect([path, (await call(client, method, path, body)).status]).toEqual([path, 403]);
    }
  });

  test("staff cannot edit profiles or hours, not even their own", async () => {
    const patch = await call(ana, "PATCH", `/admin/staff/${f.anaId}`, { displayName: "Boss" });
    expect(patch.status).toBe(403);
    const put = await call(ana, "PUT", `/admin/staff/${f.anaId}/working-hours`, hours());
    expect(put.status).toBe(403);
    expect(await errorCode(put)).toBe("forbidden");
    const rows = await t.db
      .select()
      .from(workingHours)
      .where(and(eq(workingHours.staffId, f.anaId), isNull(workingHours.deletedAt)));
    expect(rows).toHaveLength(1);
  });

  test("staff see only themselves in the admin list and read only their own hours", async () => {
    const list = listAdminStaffResponseSchema.parse(
      await (await call(ana, "GET", "/admin/staff")).json(),
    );
    expect(list.staff.map((s) => s.id)).toEqual([f.anaId]);

    expect((await call(ana, "GET", `/admin/staff/${f.anaId}/working-hours`)).status).toBe(200);
    expect((await call(ana, "GET", `/admin/staff/${f.beaId}/working-hours`)).status).toBe(403);
    expect((await call(ana, "GET", `/admin/staff/${f.beaId}/time-off`)).status).toBe(403);
  });
});

describe("GET and PATCH /admin/staff", () => {
  test("the owner lists the whole team, inactive members included", async () => {
    await call(owner, "PATCH", `/admin/staff/${f.beaId}`, { active: false });
    const list = listAdminStaffResponseSchema.parse(
      await (await call(owner, "GET", "/admin/staff")).json(),
    );
    const byId = Object.fromEntries(list.staff.map((s) => [s.id, s]));
    expect(byId[f.anaId]).toMatchObject({
      displayName: "Ana",
      active: true,
      userId: ana.userId,
    });
    expect(byId[f.anaId]?.serviceIds.sort()).toEqual([f.haircutId, f.colorId].sort());
    expect(byId[f.beaId]?.active).toBe(false);
  });

  test("renames a staff member and audits the change", async () => {
    const res = await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { displayName: "Ana M." });
    expect(res.status).toBe(200);
    expect(adminStaffSchema.parse(await res.json()).displayName).toBe("Ana M.");
    const [row] = await audit("staff.update");
    expect(row).toMatchObject({ actorUserId: owner.userId, entity: "staff", entityId: f.anaId });
    expect(row?.metadata).toMatchObject({ changed: ["displayName"] });
  });

  test("deactivating hides the calendar from the public list and reactivating restores it", async () => {
    const off = await call(owner, "PATCH", `/admin/staff/${f.beaId}`, { active: false });
    expect(adminStaffSchema.parse(await off.json()).active).toBe(false);
    const hidden = listStaffResponseSchema.parse(await (await call(null, "GET", "/staff")).json());
    expect(hidden.staff.map((s) => s.id)).toEqual([f.anaId]);
    expect((await audit("staff.deactivate")).length).toBe(1);

    await call(owner, "PATCH", `/admin/staff/${f.beaId}`, { active: true });
    const shown = listStaffResponseSchema.parse(await (await call(null, "GET", "/staff")).json());
    expect(shown.staff).toHaveLength(2);
    expect((await audit("staff.activate")).length).toBe(1);
  });

  test("404 for unknown staff and 400 for an empty body", async () => {
    expect(
      (await call(owner, "PATCH", `/admin/staff/${Bun.randomUUIDv7()}`, { active: false })).status,
    ).toBe(404);
    expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, {})).status).toBe(400);
  });
});

describe("has_future_appointments", () => {
  test("deactivating a staff member with an upcoming booking is a 409 that changes nothing", async () => {
    await bookAna();
    const res = await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: false });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("has_future_appointments");
    const list = listAdminStaffResponseSchema.parse(
      await (await call(owner, "GET", "/admin/staff")).json(),
    );
    expect(list.staff.find((s) => s.id === f.anaId)?.active).toBe(true);
    expect((await audit("staff.deactivate")).length).toBe(0);
  });

  test("the owner can unblock it by reassigning the booking to another staff member", async () => {
    const booked = await bookAna();
    const moved = await call(owner, "PATCH", `/appointments/${booked.id}`, {
      version: booked.version,
      staffId: f.beaId,
    });
    expect(moved.status).toBe(200);
    expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: false })).status).toBe(
      200,
    );
  });

  test("or by cancelling it", async () => {
    const booked = await bookAna();
    await call(owner, "PATCH", `/appointments/${booked.id}`, {
      version: booked.version,
      status: "cancelled",
    });
    expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: false })).status).toBe(
      200,
    );
  });

  test("past appointments do not block deactivation", async () => {
    await t.db.insert(appointment).values({
      staffId: f.anaId,
      clientId: f.clientId,
      startsAt: new Date("2026-02-20T12:00:00Z"),
      endsAt: new Date("2026-02-20T13:00:00Z"),
      status: "booked",
    });
    expect((await call(owner, "PATCH", `/admin/staff/${f.anaId}`, { active: false })).status).toBe(
      200,
    );
  });

  test("demoting such a staff member to client is refused the same way, then allowed", async () => {
    const booked = await bookAna();
    const refused = await call(owner, "PATCH", `/admin/users/${ana.userId}/role`, {
      role: "client",
    });
    expect(refused.status).toBe(409);
    expect(await errorCode(refused)).toBe("has_future_appointments");
    const [row] = await t.db.select().from(user).where(eq(user.id, ana.userId));
    expect(row?.role).toBe("staff");
    expect((await audit("user.role_change")).length).toBe(0);

    await call(owner, "PATCH", `/appointments/${booked.id}`, {
      version: booked.version,
      staffId: f.beaId,
    });
    expect(
      (await call(owner, "PATCH", `/admin/users/${ana.userId}/role`, { role: "client" })).status,
    ).toBe(200);
  });
});

describe("working hours", () => {
  test("PUT replaces the whole schedule, soft-deleting the old rows, and GET returns it sorted", async () => {
    const res = await call(
      owner,
      "PUT",
      `/admin/staff/${f.anaId}/working-hours`,
      hours([2, "14:00", "18:00"], [2, "09:00", "13:00"], [1, "10:00", "17:00"]),
    );
    expect(res.status).toBe(200);
    const saved = workingHoursResponseSchema.parse(await res.json());
    expect(saved.staffId).toBe(f.anaId);
    expect(saved.hours).toEqual([
      { weekday: 1, startTime: "10:00", endTime: "17:00" },
      { weekday: 2, startTime: "09:00", endTime: "13:00" },
      { weekday: 2, startTime: "14:00", endTime: "18:00" },
    ]);

    const again = workingHoursResponseSchema.parse(
      await (await call(owner, "GET", `/admin/staff/${f.anaId}/working-hours`)).json(),
    );
    expect(again.hours).toEqual(saved.hours);

    const old = await t.db
      .select()
      .from(workingHours)
      .where(and(eq(workingHours.staffId, f.anaId), eq(workingHours.startTime, "09:00:00")));
    expect(old.some((r) => r.weekday === 1 && r.deletedAt !== null)).toBe(true);

    const [row] = await audit("working_hours.replace");
    expect(row).toMatchObject({ actorUserId: owner.userId, entity: "staff", entityId: f.anaId });
    expect(row?.metadata).toMatchObject({ ranges: 3 });
  });

  test("weekly revisions reject stale edits even when their hours were restored", async () => {
    const path = `/admin/staff/${f.anaId}/working-hours`;
    const baseline = workingHoursResponseSchema.parse(
      await (await call(owner, "GET", path)).json(),
    );
    expect(baseline.revision).toBeDefined();
    const first = { ...hours([1, "10:00", "18:00"]), expectedRevision: baseline.revision };
    const changed = workingHoursResponseSchema.parse(
      await (await call(owner, "PUT", path, first)).json(),
    );
    expect(changed.revision).not.toBe(baseline.revision);
    const replay = await call(owner, "PUT", path, first);
    expect(workingHoursResponseSchema.parse(await replay.json())).toEqual(changed);
    expect(await audit("working_hours.replace")).toHaveLength(1);
    const restored = { hours: baseline.hours, expectedRevision: changed.revision };
    expect((await call(owner, "PUT", path, restored)).status).toBe(200);
    const rejected = await call(owner, "PUT", path, first);
    expect(rejected.status).toBe(409);
    expect(await errorCode(rejected)).toBe("version_conflict");
    expect(await audit("working_hours.replace")).toHaveLength(2);
  });

  test("an empty schedule makes every day a day off", async () => {
    const res = await call(owner, "PUT", `/admin/staff/${f.anaId}/working-hours`, hours());
    expect(workingHoursResponseSchema.parse(await res.json()).hours).toEqual([]);
  });

  test("overlapping or backwards ranges are rejected and nothing changes", async () => {
    for (const bad of [
      hours([1, "09:00", "13:00"], [1, "12:00", "18:00"]),
      hours([1, "18:00", "09:00"]),
    ]) {
      const res = await call(owner, "PUT", `/admin/staff/${f.anaId}/working-hours`, bad);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("validation_error");
    }
    const current = workingHoursResponseSchema.parse(
      await (await call(owner, "GET", `/admin/staff/${f.anaId}/working-hours`)).json(),
    );
    expect(current.hours).toEqual([{ weekday: 1, startTime: "09:00", endTime: "18:00" }]);
    expect((await audit("working_hours.replace")).length).toBe(0);
  });

  test("404 for an unknown staff member", async () => {
    const id = Bun.randomUUIDv7();
    expect((await call(owner, "PUT", `/admin/staff/${id}/working-hours`, hours())).status).toBe(
      404,
    );
    expect((await call(owner, "GET", `/admin/staff/${id}/working-hours`)).status).toBe(404);
  });

  test("shrinking the hours never touches bookings but lists the ones that no longer fit", async () => {
    const booked = await bookAna(); // Mon 09:00-10:00 local
    const res = await call(
      owner,
      "PUT",
      `/admin/staff/${f.anaId}/working-hours`,
      hours([1, "10:00", "18:00"]),
    );
    const body = workingHoursResponseSchema.parse(await res.json());
    expect(body.conflicts).toEqual([
      {
        appointmentId: booked.id,
        clientId: f.clientId,
        startsAt: booked.startsAt,
        endsAt: booked.endsAt,
        reasons: ["outside_working_hours"],
      },
    ]);

    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, booked.id));
    expect(row).toMatchObject({ status: "booked", version: 1 });
    expect(row?.startsAt.toISOString()).toBe(booked.startsAt);

    // GET reports the same conflicts for the saved schedule.
    const get = workingHoursResponseSchema.parse(
      await (await call(owner, "GET", `/admin/staff/${f.anaId}/working-hours`)).json(),
    );
    expect(get.conflicts.map((c) => c.appointmentId)).toEqual([booked.id]);
  });

  test("hours that still cover every booking report no conflicts; cancelled bookings are ignored", async () => {
    const booked = await bookAna();
    const fits = await call(
      owner,
      "PUT",
      `/admin/staff/${f.anaId}/working-hours`,
      hours([1, "08:00", "20:00"]),
    );
    expect(workingHoursResponseSchema.parse(await fits.json()).conflicts).toEqual([]);

    await call(owner, "PATCH", `/appointments/${booked.id}`, {
      version: booked.version,
      status: "cancelled",
    });
    const empty = await call(owner, "PUT", `/admin/staff/${f.anaId}/working-hours`, hours());
    expect(workingHoursResponseSchema.parse(await empty.json()).conflicts).toEqual([]);
  });
});

describe("time off", () => {
  const range = { startsAt: "2026-03-09T12:00:00.000Z", endsAt: "2026-03-09T16:00:00.000Z" };
  const create = (who: Actor, staffId: string, body: unknown = range) =>
    call(who, "POST", `/admin/staff/${staffId}/time-off`, body);

  test("the owner creates time off, which is audited and blocks availability", async () => {
    const res = await create(owner, f.anaId, { ...range, reason: "Dentist" });
    expect(res.status).toBe(201);
    const body = timeOffResponseSchema.parse(await res.json());
    expect(body.timeOff).toMatchObject({ staffId: f.anaId, reason: "Dentist", ...range });
    expect(body.conflicts).toEqual([]);

    const slots = (await (
      await call(
        null,
        "GET",
        `/availability?serviceIds=${f.haircutId}&staffId=${f.anaId}&date=2026-03-09`,
      )
    ).json()) as { slots: unknown[] };
    expect(slots.slots.length).toBeGreaterThan(0);
    expect(
      (slots.slots as { startsAt: string }[]).every(
        (s) => s.startsAt >= range.endsAt || s.startsAt < range.startsAt,
      ),
    ).toBe(true);

    const [row] = await audit("time_off.create");
    expect(row).toMatchObject({ actorUserId: owner.userId, entity: "time_off" });
    expect(row?.entityId).toBe(body.timeOff.id);
  });

  test("existing bookings are untouched but reported as conflicts", async () => {
    const booked = await bookAna();
    const res = await create(owner, f.anaId);
    const body = timeOffResponseSchema.parse(await res.json());
    expect(body.conflicts.map((c) => [c.appointmentId, c.reasons])).toEqual([
      [booked.id, ["time_off"]],
    ]);
    const [row] = await t.db.select().from(appointment).where(eq(appointment.id, booked.id));
    expect(row?.status).toBe("booked");
  });

  test("staff manage their own time off but not a colleague's", async () => {
    const mine = await create(ana, f.anaId);
    expect(mine.status).toBe(201);
    const id = timeOffResponseSchema.parse(await mine.json()).timeOff.id;

    expect((await create(ana, f.beaId)).status).toBe(403);
    const theirs = await create(bea, f.beaId);
    const theirId = timeOffResponseSchema.parse(await theirs.json()).timeOff.id;

    expect(
      (await call(ana, "PATCH", `/admin/staff/${f.anaId}/time-off/${id}`, { reason: "Trip" }))
        .status,
    ).toBe(200);
    expect((await call(ana, "DELETE", `/admin/staff/${f.beaId}/time-off/${theirId}`)).status).toBe(
      403,
    );
    // An entry addressed through the wrong staff id does not exist for that staff member.
    expect(
      (await call(ana, "PATCH", `/admin/staff/${f.anaId}/time-off/${theirId}`, { reason: "x" }))
        .status,
    ).toBe(404);
    const [stillThere] = await t.db.select().from(timeOff).where(eq(timeOff.id, theirId));
    expect(stillThere?.deletedAt).toBeNull();
  });

  test("PATCH moves the range, recomputes conflicts and audits it", async () => {
    const booked = await bookAna();
    const created = timeOffResponseSchema.parse(
      await (
        await create(owner, f.anaId, {
          startsAt: "2026-03-10T12:00:00.000Z",
          endsAt: "2026-03-10T14:00:00.000Z",
        })
      ).json(),
    );
    expect(created.conflicts).toEqual([]);

    const res = await call(
      owner,
      "PATCH",
      `/admin/staff/${f.anaId}/time-off/${created.timeOff.id}`,
      range,
    );
    expect(res.status).toBe(200);
    const moved = timeOffResponseSchema.parse(await res.json());
    expect(moved.timeOff).toMatchObject(range);
    expect(moved.conflicts.map((c) => c.appointmentId)).toEqual([booked.id]);
    expect((await audit("time_off.update")).length).toBe(1);
  });

  test("PATCH rejects a range that ends before it starts once merged with the stored one", async () => {
    const created = timeOffResponseSchema.parse(await (await create(owner, f.anaId)).json());
    const res = await call(
      owner,
      "PATCH",
      `/admin/staff/${f.anaId}/time-off/${created.timeOff.id}`,
      {
        endsAt: "2026-03-09T11:00:00.000Z",
      },
    );
    expect(res.status).toBe(400);
  });

  test("DELETE soft-deletes, frees the slots again and is not repeatable", async () => {
    const created = timeOffResponseSchema.parse(await (await create(owner, f.anaId)).json());
    const path = `/admin/staff/${f.anaId}/time-off/${created.timeOff.id}`;
    expect((await call(owner, "DELETE", path)).status).toBe(200);
    const [row] = await t.db.select().from(timeOff).where(eq(timeOff.id, created.timeOff.id));
    expect(row?.deletedAt).not.toBeNull();
    expect((await call(owner, "DELETE", path)).status).toBe(404);
    expect((await audit("time_off.delete")).length).toBe(1);
    // the slot is bookable again
    const booked = await call(owner, "POST", "/appointments", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    expect(booked.status).toBe(201);
  });

  test("lists entries, optionally limited to a window", async () => {
    await create(owner, f.anaId);
    await create(owner, f.anaId, {
      startsAt: "2026-04-01T12:00:00.000Z",
      endsAt: "2026-04-01T16:00:00.000Z",
    });
    const all = listTimeOffResponseSchema.parse(
      await (await call(owner, "GET", `/admin/staff/${f.anaId}/time-off`)).json(),
    );
    expect(all.timeOff).toHaveLength(2);
    const march = listTimeOffResponseSchema.parse(
      await (
        await call(
          owner,
          "GET",
          `/admin/staff/${f.anaId}/time-off?from=2026-03-01T00:00:00Z&to=2026-03-31T00:00:00Z`,
        )
      ).json(),
    );
    expect(march.timeOff).toHaveLength(1);
  });

  test("rejects invalid ranges with 400 and unknown staff with 404", async () => {
    expect((await create(owner, f.anaId, { ...range, endsAt: range.startsAt })).status).toBe(400);
    expect((await create(owner, Bun.randomUUIDv7())).status).toBe(404);
  });
});
