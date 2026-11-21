import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  changeRoleResponseSchema,
  errorResponseSchema,
  meResponseSchema,
  staffAccountResponseSchema,
} from "@sob/contracts";
import { auditLog, staffProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  json,
  PASSWORD,
  setupApiTest,
  signIn,
  signUp,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let staff: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  [owner, staff, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "staff", "staff@example.com"),
    actor(t, "client", "client@example.com"),
  ]);
});

const newStaff = { email: "Nina@Example.com", name: "Nina", password: PASSWORD };

const createStaff = (who: Actor | null, body: unknown = newStaff) =>
  json(t.app, "/admin/staff-accounts", "POST", body, who?.cookie);
const setRole = (who: Actor | null, userId: string, role: string) =>
  json(t.app, `/admin/users/${userId}/role`, "PATCH", { role }, who?.cookie);

async function code(res: Response) {
  return errorResponseSchema.parse(await res.json()).error.code;
}

describe("POST /admin/staff-accounts", () => {
  test("linking a login uses the reviewed existing calendar and preserves its name and preset", async () => {
    const [existing] = await t.db
      .insert(staffProfile)
      .values({ displayName: "Existing professional", accessPreset: "receptionist" })
      .returning();
    if (!existing) throw new Error("Missing existing calendar");
    const before = await t.db.select().from(staffProfile);
    const res = await createStaff(owner, {
      ...newStaff,
      existingCalendar: {
        staffId: existing.id,
        version: existing.accessVersion,
        generation: "initial",
      },
    });
    expect(res.status).toBe(201);
    const created = staffAccountResponseSchema.parse(await res.json());
    expect(created.staffId).toBe(existing.id);
    const after = await t.db.select().from(staffProfile);
    expect(after).toHaveLength(before.length);
    expect(after.find((row) => row.id === existing.id)).toMatchObject({
      displayName: existing.displayName,
      active: existing.active,
      accessPreset: existing.accessPreset,
      userId: created.userId,
      accessVersion: existing.accessVersion + 1,
    });
  });

  test("a restored centre or a missing email provider leaves the calendar unlinked", async () => {
    const [existing] = await t.db
      .insert(staffProfile)
      .values({ displayName: "Existing professional" })
      .returning();
    if (!existing) throw new Error("Missing existing calendar");
    const reviewed = {
      staffId: existing.id,
      version: existing.accessVersion,
      generation: "initial",
    };
    const stale = await createStaff(owner, {
      ...newStaff,
      existingCalendar: { ...reviewed, generation: "previous" },
    });
    expect(stale.status).toBe(409);
    expect(await code(stale)).toBe("sync_generation_changed");
    const misspelled = await createStaff(owner, { ...newStaff, existingCalender: reviewed });
    expect(misspelled.status).toBe(400);
    const invite = await createStaff(owner, {
      email: newStaff.email,
      name: newStaff.name,
      existingCalendar: reviewed,
    });
    expect(invite.status).toBe(503);
    expect(await code(invite)).toBe("email_unavailable");
    expect(await t.db.select().from(user).where(eq(user.email, "nina@example.com"))).toHaveLength(
      0,
    );
    const [unchanged] = await t.db
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.id, existing.id));
    expect(unchanged?.userId).toBeNull();
    expect(unchanged?.accessVersion).toBe(existing.accessVersion);
    const renamed = await json(
      t.app,
      `/admin/staff/${existing.id}`,
      "PATCH",
      {
        displayName: "Renamed professional",
      },
      owner.cookie,
    );
    expect(renamed.status).toBe(200);
    const oldName = await createStaff(owner, { ...newStaff, existingCalendar: reviewed });
    expect(await code(oldName)).toBe("version_conflict");
  });

  test("concurrent owners cannot attach two logins to one calendar", async () => {
    const [existing] = await t.db
      .insert(staffProfile)
      .values({ displayName: "Existing professional" })
      .returning();
    if (!existing) throw new Error("Missing existing calendar");
    const existingCalendar = {
      staffId: existing.id,
      version: existing.accessVersion,
      generation: "initial",
    };
    const responses = await Promise.all([
      createStaff(owner, { ...newStaff, existingCalendar }),
      createStaff(owner, { ...newStaff, email: "second@example.com", existingCalendar }),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winner = responses.find(({ status }) => status === 201);
    const rejected = responses.find(({ status }) => status === 409);
    if (!winner || !rejected) throw new Error("Missing invitation results");
    expect(await code(rejected)).toBe("version_conflict");
    const created = staffAccountResponseSchema.parse(await winner.json());
    const [linked] = await t.db.select().from(staffProfile).where(eq(staffProfile.id, existing.id));
    expect(linked?.userId).toBe(created.userId);
    const accounts = await t.db.select().from(user);
    expect(
      accounts
        .map(({ email }) => email)
        .filter((email) => ["nina@example.com", "second@example.com"].includes(email)),
    ).toEqual([created.email]);
  });

  test("the owner creates a staff login with a calendar profile that can sign in", async () => {
    const res = await createStaff(owner, { ...newStaff, displayName: "Nina R." });
    expect(res.status).toBe(201);
    const created = staffAccountResponseSchema.parse(await res.json());
    expect(created).toMatchObject({ email: "nina@example.com", role: "staff" });

    const [profile] = await t.db
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.id, created.staffId));
    expect(profile).toMatchObject({ displayName: "Nina R.", userId: created.userId });

    const { res: login, cookie } = await signIn(t.app, "nina@example.com");
    expect(login.status).toBe(200);
    const me = meResponseSchema.parse(
      await (await json(t.app, "/me", "GET", undefined, cookie)).json(),
    );
    expect(me).toMatchObject({ user: { role: "staff" }, staffId: created.staffId, clientId: null });
  });

  test("only the owner may do it: anonymous 401, client 403, staff 403", async () => {
    const anonymous = await createStaff(null);
    expect(anonymous.status).toBe(401);
    expect(await code(anonymous)).toBe("unauthorized");
    for (const who of [client, staff]) {
      const res = await createStaff(who);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
    }
    expect(await t.db.select().from(user).where(eq(user.email, "nina@example.com"))).toHaveLength(
      0,
    );
  });

  test("public sign-up can never produce staff, even when asked", async () => {
    const res = await json(t.app, "/api/auth/sign-up/email", "POST", {
      email: "wannabe@example.com",
      name: "Wannabe",
      password: PASSWORD,
      role: "staff",
    });
    const [row] = await t.db.select().from(user).where(eq(user.email, "wannabe@example.com"));
    expect(row?.role ?? "client").toBe("client");
    expect(res.status === 200 || res.status === 400).toBe(true);
  });

  test("validates the body and rejects a duplicate email", async () => {
    const weak = await createStaff(owner, { ...newStaff, password: "short" });
    expect(weak.status).toBe(400);
    expect(await code(weak)).toBe("validation_error");

    expect((await createStaff(owner)).status).toBe(201);
    const dup = await createStaff(owner);
    expect(dup.status).toBe(409);
    expect(await code(dup)).toBe("invalid_state");
  });

  test("is audited with the actor and without the password", async () => {
    const created = staffAccountResponseSchema.parse(await (await createStaff(owner)).json());
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "staff.create"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: owner.userId,
      entity: "user",
      entityId: created.userId,
    });
    expect(rows[0]?.metadata).toMatchObject({
      email: "nina@example.com",
      staffId: created.staffId,
    });
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
  });
});

describe("PATCH /admin/users/:id/role", () => {
  test("the owner promotes a client to staff, and the profile appears", async () => {
    const { userId } = await signUp(t.app, "lucia@example.com", "Lucia");
    const res = await setRole(owner, userId, "staff");
    expect(res.status).toBe(200);
    const body = changeRoleResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ userId, role: "staff" });
    expect(body.staffId).not.toBeNull();
    expect(body.clientId).not.toBeNull();
  });

  test("only the owner may assign roles", async () => {
    const { userId } = await signUp(t.app, "lucia@example.com", "Lucia");
    expect((await setRole(null, userId, "staff")).status).toBe(401);
    for (const who of [client, staff]) {
      const res = await setRole(who, userId, "owner");
      expect(res.status).toBe(403);
      expect(await code(res)).toBe("forbidden");
    }
    const [row] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(row?.role).toBe("client");
  });

  test("a client cannot promote themselves", async () => {
    const res = await setRole(client, client.userId, "owner");
    expect(res.status).toBe(403);
    const [row] = await t.db.select().from(user).where(eq(user.id, client.userId));
    expect(row?.role).toBe("client");
  });

  test("the owner cannot change their own role (no accidental lock-out)", async () => {
    const res = await setRole(owner, owner.userId, "client");
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("forbidden");
  });

  test("404 for an unknown user and 400 for an unknown role or a malformed body", async () => {
    expect((await setRole(owner, "missing-user", "staff")).status).toBe(404);
    const bad = await setRole(owner, client.userId, "superuser");
    expect(bad.status).toBe(400);
    expect(await code(bad)).toBe("validation_error");
  });

  test("is audited with the previous and the new role", async () => {
    await setRole(owner, client.userId, "staff");
    const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "user.role_change"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: owner.userId,
      entity: "user",
      entityId: client.userId,
      metadata: { from: "client", to: "staff" },
    });
  });

  test("a failed change leaves no audit row", async () => {
    await setRole(staff, client.userId, "owner");
    await setRole(owner, "missing-user", "staff");
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
