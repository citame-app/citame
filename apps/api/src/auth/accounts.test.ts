import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { meResponseSchema } from "@sob/contracts";
import { account, auditLog, clientProfile, staffProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import { json, PASSWORD, setupApiTest, signIn, signUp } from "../../test/helpers";
import { DomainError } from "../errors";
import { assignRole, bootstrapOwner, createAccount, ownerFromEnv } from "./accounts";
import { createAuth } from "./auth";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let deps: { auth: ReturnType<typeof createAuth>; db: typeof t.db };

beforeAll(async () => {
  t = await setupApiTest();
  deps = { auth: createAuth({ db: t.db, valkey: t.valkey.client, config: t.config }), db: t.db };
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function profilesOf(userId: string) {
  const staff = await t.db.select().from(staffProfile).where(eq(staffProfile.userId, userId));
  const client = await t.db.select().from(clientProfile).where(eq(clientProfile.userId, userId));
  return { staff, client };
}

describe("createAccount", () => {
  test("a staff account gets role staff, a linked calendar profile and no client profile", async () => {
    const result = await createAccount(deps, {
      email: "Ana@Example.com",
      name: "Ana Maria",
      password: PASSWORD,
      role: "staff",
      displayName: "Ana M.",
    });
    expect(result.role).toBe("staff");
    expect(result.staffId).not.toBeNull();
    expect(result.clientId).toBeNull();

    const [row] = await t.db.select().from(user).where(eq(user.id, result.userId));
    expect(row).toMatchObject({ email: "ana@example.com", role: "staff" });
    const profiles = await profilesOf(result.userId);
    expect(profiles.staff).toHaveLength(1);
    expect(profiles.staff[0]).toMatchObject({ displayName: "Ana M.", active: true });
    expect(profiles.client).toHaveLength(0);
  });

  test("the created credentials work through the public sign-in endpoint", async () => {
    await createAccount(deps, {
      email: "ana@example.com",
      name: "Ana",
      password: PASSWORD,
      role: "staff",
    });
    const { res, cookie } = await signIn(t.app, "ana@example.com");
    expect(res.status).toBe(200);
    const me = meResponseSchema.parse(
      await (await json(t.app, "/me", "GET", undefined, cookie)).json(),
    );
    expect(me.user.role).toBe("staff");
    expect(me.staffId).not.toBeNull();
    expect(me.clientId).toBeNull();
  });

  test("stores only a hash of the password", async () => {
    const { userId } = await createAccount(deps, {
      email: "ana@example.com",
      name: "Ana",
      password: PASSWORD,
      role: "staff",
    });
    const [row] = await t.db.select().from(account).where(eq(account.userId, userId));
    expect(row?.providerId).toBe("credential");
    expect(row?.password).toBeTruthy();
    expect(row?.password).not.toContain(PASSWORD);
  });

  test("an owner account has no calendar or booking profile", async () => {
    const result = await createAccount(deps, {
      email: "boss@example.com",
      name: "Boss",
      password: PASSWORD,
      role: "owner",
    });
    expect(result).toMatchObject({ role: "owner", staffId: null, clientId: null });
    const profiles = await profilesOf(result.userId);
    expect(profiles.staff).toHaveLength(0);
    expect(profiles.client).toHaveLength(0);
  });

  test("a duplicate email is a 409 invalid_state and leaves nothing behind", async () => {
    await signUp(t.app, "taken@example.com");
    const attempt = createAccount(deps, {
      email: "TAKEN@example.com",
      name: "Other",
      password: PASSWORD,
      role: "staff",
    });
    expect(attempt).rejects.toBeInstanceOf(DomainError);
    expect((await attempt.catch((e: unknown) => e)) as DomainError).toMatchObject({
      code: "invalid_state",
    });
    expect(await t.db.select().from(staffProfile)).toHaveLength(0);
  });
});

describe("assignRole", () => {
  test("promoting a client to staff creates the calendar profile and keeps the booking profile", async () => {
    const { userId } = await signUp(t.app, "lucia@example.com", "Lucia");
    const result = await assignRole(t.db, userId, "staff");
    expect(result.role).toBe("staff");
    expect(result.staffId).not.toBeNull();
    expect(result.clientId).not.toBeNull();
    const [row] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(row?.role).toBe("staff");
  });

  test("demoting staff deactivates the calendar so nobody can book it, promoting again reactivates", async () => {
    const staff = await createAccount(deps, {
      email: "ana@example.com",
      name: "Ana",
      password: PASSWORD,
      role: "staff",
    });
    await assignRole(t.db, staff.userId, "client");
    let [profile] = await t.db
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.userId, staff.userId));
    expect(profile?.active).toBe(false);
    const demoted = await assignRole(t.db, staff.userId, "client");
    expect(demoted.clientId).not.toBeNull();

    await assignRole(t.db, staff.userId, "staff");
    [profile] = await t.db.select().from(staffProfile).where(eq(staffProfile.userId, staff.userId));
    expect(profile?.active).toBe(true);
  });

  test("the new role applies to the user's existing session immediately", async () => {
    const { userId, cookie } = await signUp(t.app, "lucia@example.com");
    expect(
      meResponseSchema.parse(await (await json(t.app, "/me", "GET", undefined, cookie)).json()).user
        .role,
    ).toBe("client");
    await assignRole(t.db, userId, "owner");
    expect(
      meResponseSchema.parse(await (await json(t.app, "/me", "GET", undefined, cookie)).json()).user
        .role,
    ).toBe("owner");
  });

  test("an unknown user is not_found", async () => {
    const error = await assignRole(t.db, "missing", "staff").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("not_found");
  });
});

describe("bootstrapOwner", () => {
  const input = { email: "owner@example.com", password: PASSWORD, name: "Owner" };

  test("creates the first owner exactly once; running it again changes nothing", async () => {
    const first = await bootstrapOwner(deps, input);
    expect(first.created).toBe(true);
    const second = await bootstrapOwner(deps, { ...input, password: "a completely different one" });
    expect(second).toEqual({ created: false, userId: first.userId });

    const users = await t.db.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe("owner");
    // The original password still works: bootstrap never overwrites credentials.
    expect((await signIn(t.app, "owner@example.com")).res.status).toBe(200);
    expect(
      (await signIn(t.app, "owner@example.com", "a completely different one")).res.status,
    ).toBe(401);
  });

  test("is audited once, without the password, and a repeat run adds nothing", async () => {
    const first = await bootstrapOwner(deps, input);
    await bootstrapOwner(deps, input);
    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      action: "owner.bootstrap",
      entityId: first.userId,
    });
    expect(JSON.stringify(rows[0])).not.toContain(PASSWORD);
  });

  test("refuses to promote an existing non-owner account (someone could have pre-registered the email)", async () => {
    await signUp(t.app, "owner@example.com", "Squatter");
    const error = await bootstrapOwner(deps, input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("invalid_state");
    const [row] = await t.db.select().from(user).where(eq(user.email, "owner@example.com"));
    expect(row?.role).toBe("client");
  });

  test("rejects a weak password", async () => {
    const error = await bootstrapOwner(deps, { ...input, password: "short" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("validation_error");
    expect(await t.db.select().from(user)).toHaveLength(0);
  });
});

describe("ownerFromEnv", () => {
  test("reads OWNER_EMAIL and OWNER_PASSWORD, with an optional OWNER_NAME", () => {
    expect(ownerFromEnv({ OWNER_EMAIL: "o@example.com", OWNER_PASSWORD: PASSWORD })).toEqual({
      email: "o@example.com",
      password: PASSWORD,
      name: "Owner",
    });
    expect(
      ownerFromEnv({ OWNER_EMAIL: "o@example.com", OWNER_PASSWORD: PASSWORD, OWNER_NAME: "Sofia" })
        .name,
    ).toBe("Sofia");
  });

  test("names the missing variable but never echoes the password", () => {
    expect(() => ownerFromEnv({ OWNER_PASSWORD: "super-secret-value" })).toThrow(/OWNER_EMAIL/);
    expect(() => ownerFromEnv({ OWNER_EMAIL: "o@example.com" })).toThrow(/OWNER_PASSWORD/);
    try {
      ownerFromEnv({ OWNER_EMAIL: "not-an-email", OWNER_PASSWORD: "super-secret-value" });
      throw new Error("expected ownerFromEnv to throw");
    } catch (error) {
      expect(String(error)).not.toContain("super-secret-value");
    }
  });
});
