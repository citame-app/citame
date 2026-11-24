import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { errorResponseSchema, meResponseSchema } from "@sob/contracts";
import { account, clientProfile, session, user } from "@sob/db";
import { eq } from "drizzle-orm";
import { json, PASSWORD, setupApiTest, signIn, signUp } from "../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;

beforeAll(async () => {
  t = await setupApiTest();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function me(cookie?: string) {
  return json(t.app, "/me", "GET", undefined, cookie);
}

describe("sign-up", () => {
  test("creates a client user, a linked client profile and a session cookie", async () => {
    const { cookie, userId } = await signUp(t.app, "lucia@example.com", "Lucia");
    expect(cookie).toContain("session_token=");

    const [row] = await t.db.select().from(user).where(eq(user.id, userId));
    expect(row).toMatchObject({ email: "lucia@example.com", name: "Lucia", role: "client" });
    // Better Auth ids are UUIDv7 (version nibble 7).
    expect(userId.split("-")[2]?.[0]).toBe("7");

    const [profile] = await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.userId, userId));
    expect(profile).toMatchObject({ name: "Lucia", email: "lucia@example.com" });
  });

  test("stores a hashed password, never the plain one", async () => {
    const { userId } = await signUp(t.app, "lucia@example.com");
    const [row] = await t.db.select().from(account).where(eq(account.userId, userId));
    expect(row?.password).toBeTruthy();
    expect(row?.password).not.toBe(PASSWORD);
    expect(row?.password).not.toContain(PASSWORD);
  });

  test("cannot grant itself a role through the request body", async () => {
    const res = await json(t.app, "/api/auth/sign-up/email", "POST", {
      email: "sneaky@example.com",
      name: "Sneaky",
      password: PASSWORD,
      role: "owner",
    });
    const [row] = await t.db.select().from(user).where(eq(user.email, "sneaky@example.com"));
    // Either the request is rejected or the role is ignored; it never becomes owner.
    expect(row?.role ?? "client").toBe("client");
    if (res.status === 200) expect(row?.role).toBe("client");
  });

  test("rejects a duplicate email and a short password", async () => {
    await signUp(t.app, "dup@example.com");
    const dup = await json(t.app, "/api/auth/sign-up/email", "POST", {
      email: "dup@example.com",
      name: "Dup",
      password: PASSWORD,
    });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect(dup.status).toBeLessThan(500);

    const weak = await json(t.app, "/api/auth/sign-up/email", "POST", {
      email: "weak@example.com",
      name: "Weak",
      password: "short",
    });
    expect(weak.status).toBe(400);
  });
});

describe("sign-in and session", () => {
  test("signs in with the right password and reads the session through the cookie", async () => {
    const { userId } = await signUp(t.app, "lucia@example.com", "Lucia");
    const { res, cookie } = await signIn(t.app, "lucia@example.com");
    expect(res.status).toBe(200);

    const profile = await me(cookie);
    expect(profile.status).toBe(200);
    const body = meResponseSchema.parse(await profile.json());
    expect(body.user).toMatchObject({ id: userId, email: "lucia@example.com", role: "client" });
    expect(body.staffId).toBeNull();
    expect(body.clientId).not.toBeNull();
  });

  test("loads the principal once on the account and appointment routes", async () => {
    const { cookie } = await signUp(t.app, "lucia@example.com");
    const queries = spyOn(t.db.$client, "unsafe");
    try {
      const cases = [
        { path: "/me", method: "GET", body: undefined, status: 200 },
        { path: "/me/desktop-workspaces", method: "GET", body: undefined, status: 200 },
        { path: "/appointments", method: "POST", body: {}, status: 400 },
      ];
      for (const { path, method, body, status } of cases) {
        queries.mockClear();
        expect((await json(t.app, path, method, body, cookie)).status).toBe(status);
        const staffReads = queries.mock.calls.filter(
          ([query]) =>
            query.includes('from "staff_profile"') && query.includes('"staff_profile"."user_id"'),
        );
        expect(staffReads).toHaveLength(1);
      }
    } finally {
      queries.mockRestore();
    }
  });

  test("rejects a wrong password and an unknown email without leaking which one", async () => {
    await signUp(t.app, "lucia@example.com");
    const wrong = await signIn(t.app, "lucia@example.com", "not the password at all");
    const unknown = await signIn(t.app, "nobody@example.com");
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(await wrong.res.text()).toBe(await unknown.res.text());
    expect(wrong.cookie).not.toContain("session_token=");
  });

  test("without a cookie, /me answers 401 unauthorized in the stable error shape", async () => {
    const res = await me();
    expect(res.status).toBe(401);
    expect(errorResponseSchema.parse(await res.json()).error.code).toBe("unauthorized");
  });

  test("a garbage session cookie is treated as anonymous", async () => {
    const res = await me("better-auth.session_token=forged.value");
    expect(res.status).toBe(401);
  });

  test("sign-out invalidates the session", async () => {
    await signUp(t.app, "lucia@example.com");
    const { cookie } = await signIn(t.app, "lucia@example.com");
    expect((await me(cookie)).status).toBe(200);

    const out = await json(t.app, "/api/auth/sign-out", "POST", {}, cookie);
    expect(out.status).toBe(200);
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("Valkey session storage", () => {
  test("sessions are served from Valkey under the configured prefix and kept durably in Postgres", async () => {
    await signUp(t.app, "lucia@example.com");
    const keys = (await t.valkey.client.send("KEYS", [`${t.valkey.prefix}*`])) as string[];
    expect(keys.length).toBeGreaterThan(0);
    // The OAuth provider links refresh tokens to the session row (ADR 0009), so the durable copy
    // must exist.
    expect(await t.db.select().from(session)).toHaveLength(1);
  });

  test("flushing Valkey does not log anyone out: the database copy repopulates the cache", async () => {
    await signUp(t.app, "lucia@example.com");
    const { cookie } = await signIn(t.app, "lucia@example.com");
    expect((await me(cookie)).status).toBe(200);
    await t.valkey.clear();
    expect((await me(cookie)).status).toBe(200);
  });

  test("sign-out removes the session from both stores", async () => {
    await signUp(t.app, "lucia@example.com");
    const { cookie } = await signIn(t.app, "lucia@example.com");
    const before = (await t.db.select().from(session)).length;
    expect((await json(t.app, "/api/auth/sign-out", "POST", {}, cookie)).status).toBe(200);
    await t.valkey.clear();
    expect((await me(cookie)).status).toBe(401);
    expect(await t.db.select().from(session)).toHaveLength(before - 1);
  });
});

describe("cookies and origins", () => {
  test("session cookie is HttpOnly and SameSite=Lax; not Secure over plain http", async () => {
    const res = await json(t.app, "/api/auth/sign-up/email", "POST", {
      email: "c@example.com",
      name: "C",
      password: PASSWORD,
    });
    const setCookie = res.headers.getSetCookie().find((c) => c.includes("session_token=")) ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).not.toMatch(/;\s*Secure/i);
  });

  test("with an https base URL the cookie is Secure", async () => {
    const secure = await setupApiTest({ env: { BETTER_AUTH_URL: "https://salon.example" } });
    try {
      const res = await secure.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://salon.example" },
        body: JSON.stringify({ email: "s@example.com", name: "S", password: PASSWORD }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie().find((c) => c.includes("session_token=")) ?? "";
      expect(setCookie).toMatch(/;\s*Secure/i);
      expect(setCookie).toMatch(/HttpOnly/i);
    } finally {
      await secure.close();
    }
  });

  test("cookie-authenticated mutations from an untrusted origin are refused (CSRF)", async () => {
    const custom = await setupApiTest({ env: { TRUSTED_ORIGINS: "https://app.salon.example" } });
    try {
      // Better Auth only enforces the origin check on requests that carry cookies.
      const { cookie } = await signUp(custom.app, "o@example.com", "O");
      const signOut = (origin: string) =>
        custom.app.request("/api/auth/sign-out", {
          method: "POST",
          headers: { "content-type": "application/json", origin, cookie },
          body: "{}",
        });
      expect((await signOut("https://evil.example")).status).toBe(403);
      expect((await json(custom.app, "/me", "GET", undefined, cookie)).status).toBe(200);
      expect((await signOut("https://app.salon.example")).status).toBe(200);
    } finally {
      await custom.close();
    }
  });
});
