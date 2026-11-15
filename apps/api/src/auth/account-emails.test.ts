import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { accountEmailOutbox, auditLog, clientProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  actor,
  cookieFrom,
  type Fixtures,
  json,
  MONDAY_0900,
  PASSWORD,
  seedFixtures,
  setupApiTest,
  signIn,
} from "../../test/helpers";
import { expectNoMailTo, linkIn, mailTo, pathOf } from "../../test/mail";
import { FakeEmailProvider } from "../notifications/providers/fake";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let mail: FakeEmailProvider;
let f: Fixtures;

beforeAll(async () => {
  mail = new FakeEmailProvider();
  t = await setupApiTest({
    dbSuffix: "account_emails",
    env: { AUTH_REQUIRE_EMAIL_VERIFICATION: "true" },
    deps: { emailProvider: mail },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  mail.calls.length = 0;
  mail.delivered.clear();
  f = await seedFixtures(t.db);
});

const signUpRaw = (email: string, name = "New Client") =>
  json(t.app, "/api/auth/sign-up/email", "POST", {
    email,
    name,
    password: PASSWORD,
    callbackURL: "/account",
  });

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.includes("session_token") && !c.includes("=;"));

describe("email verification", () => {
  test("sign-up commits the encrypted delivery job before responding, without waiting for SMTP", async () => {
    let release = () => {};
    let watchdogFired = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    mail.beforeDeliver = () => held;
    const watchdog = setTimeout(() => {
      watchdogFired = true;
      release();
    }, 5000);
    try {
      const res = await signUpRaw("durable@example.com");
      expect(res.status).toBe(200);
      const jobs = await t.db.select().from(accountEmailOutbox);
      expect(jobs).toHaveLength(1);
      expect(JSON.stringify(jobs)).not.toContain("durable@example.com");
      expect(watchdogFired).toBe(false);
    } finally {
      clearTimeout(watchdog);
      release();
      mail.beforeDeliver = undefined;
    }
  });

  test("sign-up creates the account but no session, and sends one verification email", async () => {
    const res = await signUpRaw("ana.client@example.com");
    expect(res.status).toBe(200);
    expect(sessionCookie(res)).toBeUndefined();
    const [row] = await t.db.select().from(user).where(eq(user.email, "ana.client@example.com"));
    expect(row?.emailVerified).toBe(false);
    expect(row?.role).toBe("client");

    const message = await mailTo(mail, "ana.client@example.com");
    expect(message.subject).toContain("Confirm");
    expect(linkIn(message)).toContain("/api/auth/verify-email?token=");
    expect(message.idempotencyKey).toBeTruthy();
  });

  test("an unverified client cannot sign in, so cannot book", async () => {
    await signUpRaw("early@example.com");
    const { res, cookie } = await signIn(t.app, "early@example.com");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("EMAIL_NOT_VERIFIED");
    expect(cookie).toBe("");
    const book = await json(t.app, "/appointments", "POST", {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
    });
    expect(book.status).toBe(401);
  });

  test("following the emailed link verifies the address, signs the person in and unlocks booking", async () => {
    await signUpRaw("lu@example.com");
    const link = linkIn(await mailTo(mail, "lu@example.com"));
    const verify = await t.app.request(pathOf(link), {
      headers: { origin: "http://localhost:3000" },
    });
    expect(verify.status).toBe(302);
    expect(verify.headers.get("location")).toContain("/account");
    const cookie = cookieFrom(verify);
    expect(cookie).toContain("session_token");

    const [row] = await t.db.select().from(user).where(eq(user.email, "lu@example.com"));
    expect(row?.emailVerified).toBe(true);
    const book = await json(
      t.app,
      "/appointments",
      "POST",
      { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900 },
      cookie,
    );
    expect(book.status).toBe(201);
    // And the password they chose works for later sign-ins.
    expect((await signIn(t.app, "lu@example.com")).res.status).toBe(200);
  });

  test("a tampered or expired token verifies nothing and redirects with an error", async () => {
    await signUpRaw("tamper@example.com");
    const link = new URL(linkIn(await mailTo(mail, "tamper@example.com")));
    link.searchParams.set("token", `${link.searchParams.get("token")}x`);
    const res = await t.app.request(pathOf(link.toString()), {
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(/error=/i);
    expect(sessionCookie(res)).toBeUndefined();
    const [row] = await t.db.select().from(user).where(eq(user.email, "tamper@example.com"));
    expect(row?.emailVerified).toBe(false);
  });

  test("signing up again with a taken address looks identical and tells the owner instead", async () => {
    const first = await signUpRaw("dup@example.com");
    await mailTo(mail, "dup@example.com");
    const before = mail.calls.length;
    const second = await signUpRaw("dup@example.com");
    expect(second.status).toBe(first.status);
    expect(Object.keys((await second.json()) as object).sort()).toEqual(
      Object.keys((await first.json()) as object).sort(),
    );
    const notice = await mailTo(mail, "dup@example.com", { after: before });
    expect(notice.subject).toContain("already");
    expect(linkIn(notice)).toContain("/reset-password");
    const rows = await t.db.select().from(user).where(eq(user.email, "dup@example.com"));
    expect(rows).toHaveLength(1);
  });

  test("resending is generic: unknown addresses get the same answer and no email", async () => {
    await signUpRaw("known@example.com");
    await mailTo(mail, "known@example.com");
    const ask = (email: string) =>
      json(t.app, "/api/auth/send-verification-email", "POST", { email, callbackURL: "/account" });
    const a = await ask("known@example.com");
    const b = await ask("ghost@example.com");
    expect(b.status).toBe(a.status);
    expect(await b.json()).toEqual(await a.json());
    await expectNoMailTo(mail, "ghost@example.com");
  });

  test("owners and staff created by the owner are verified from the start", async () => {
    const owner = await actor(t, "owner", "boss@example.com");
    const [row] = await t.db.select().from(user).where(eq(user.id, owner.userId));
    expect(row?.emailVerified).toBe(true);
    const staff = await actor(t, "staff", "stylist@example.com");
    const [srow] = await t.db.select().from(user).where(eq(user.id, staff.userId));
    expect(srow?.emailVerified).toBe(true);
  });

  test("the client profile is still created at sign-up, ready for the first booking", async () => {
    await signUpRaw("profile@example.com", "Pat Profile");
    const [profile] = await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.email, "profile@example.com"));
    expect(profile?.name).toBe("Pat Profile");
  });
});

describe("password reset", () => {
  async function verifiedClient(email: string) {
    await signUpRaw(email);
    const link = linkIn(await mailTo(mail, email));
    await t.app.request(pathOf(link), { headers: { origin: "http://localhost:3000" } });
    mail.calls.length = 0;
  }
  const requestReset = (email: string) =>
    json(t.app, "/api/auth/request-password-reset", "POST", {
      email,
      redirectTo: "/reset-password",
    });

  test("known and unknown addresses get byte-identical answers; only the known one gets mail", async () => {
    await verifiedClient("forgot@example.com");
    const known = await requestReset("forgot@example.com");
    const unknown = await requestReset("nobody@example.com");
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    const message = await mailTo(mail, "forgot@example.com");
    expect(message.subject).toContain("Reset");
    expect(linkIn(message)).toContain("/api/auth/reset-password/");
    await expectNoMailTo(mail, "nobody@example.com");
  });

  test("the whole flow: link, new password, old password dead, token single-use, sessions revoked", async () => {
    await verifiedClient("flow@example.com");
    const old = await signIn(t.app, "flow@example.com");
    expect(old.res.status).toBe(200);

    await requestReset("flow@example.com");
    const link = linkIn(await mailTo(mail, "flow@example.com"));
    const landing = await t.app.request(pathOf(link), {
      headers: { origin: "http://localhost:3000" },
    });
    expect(landing.status).toBe(302);
    const target = new URL(landing.headers.get("location") as string, "http://localhost:3000");
    expect(target.pathname).toBe("/reset-password");
    const token = target.searchParams.get("token") as string;
    expect(token).toBeTruthy();

    const done = await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "a brand new passphrase",
    });
    expect(done.status).toBe(200);
    expect((await signIn(t.app, "flow@example.com")).res.status).toBe(401);
    expect((await signIn(t.app, "flow@example.com", "a brand new passphrase")).res.status).toBe(
      200,
    );

    const again = await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "yet another passphrase",
    });
    expect(again.status).toBe(400);

    // The session that existed before the reset no longer works.
    const me = await json(t.app, "/me", "GET", undefined, old.cookie);
    expect(me.status).toBe(401);
  });

  test("weak passwords are refused and the token survives for another try", async () => {
    await verifiedClient("weak@example.com");
    await requestReset("weak@example.com");
    const link = linkIn(await mailTo(mail, "weak@example.com"));
    const landing = await t.app.request(pathOf(link), {
      headers: { origin: "http://localhost:3000" },
    });
    const token = new URL(landing.headers.get("location") as string, "http://x").searchParams.get(
      "token",
    ) as string;
    const weak = await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "short",
    });
    expect(weak.status).toBe(400);
    const ok = await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "long enough now",
    });
    expect(ok.status).toBe(200);
  });

  test("an invalid token redirects with an error instead of leaking anything", async () => {
    const res = await t.app.request(
      "/api/auth/reset-password/not-a-real-token?callbackURL=%2Freset-password",
      { headers: { origin: "http://localhost:3000" } },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=INVALID_TOKEN");
  });

  test("repeated requests for one address send at most one email per minute", async () => {
    await verifiedClient("spam@example.com");
    for (let i = 0; i < 4; i++) await requestReset("spam@example.com");
    await Bun.sleep(400);
    expect(mail.calls.filter((m) => m.to === "spam@example.com")).toHaveLength(1);
  });

  test("a reset proves control of the mailbox, so it also verifies an unverified account", async () => {
    await signUpRaw("unverified@example.com");
    await mailTo(mail, "unverified@example.com");
    mail.calls.length = 0;
    await requestReset("unverified@example.com");
    const link = linkIn(await mailTo(mail, "unverified@example.com"));
    const landing = await t.app.request(pathOf(link), {
      headers: { origin: "http://localhost:3000" },
    });
    const token = new URL(landing.headers.get("location") as string, "http://x").searchParams.get(
      "token",
    ) as string;
    await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "fresh passphrase",
    });
    const [row] = await t.db.select().from(user).where(eq(user.email, "unverified@example.com"));
    expect(row?.emailVerified).toBe(true);
    expect((await signIn(t.app, "unverified@example.com", "fresh passphrase")).res.status).toBe(
      200,
    );
  });

  test("the email follows the visitor's language", async () => {
    await verifiedClient("es@example.com");
    await t.app.request("/api/auth/request-password-reset", {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        "content-type": "application/json",
        cookie: "sob_locale=es-AR",
      },
      body: JSON.stringify({ email: "es@example.com", redirectTo: "/reset-password" }),
    });
    const message = await mailTo(mail, "es@example.com");
    expect(message.subject).toContain("Restablece");
    expect(message.html).toContain('lang="es-AR"');
  });
});

describe("staff invitations", () => {
  test("the owner invites staff without choosing their password", async () => {
    const owner = await actor(t, "owner", "boss@example.com");
    const res = await json(
      t.app,
      "/admin/staff-accounts",
      "POST",
      { email: "new.stylist@example.com", name: "New Stylist" },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invited: boolean; staffId: string };
    expect(body.invited).toBe(true);
    expect(body.staffId).toBeTruthy();

    // No sign-in until they set a password: nobody, the owner included, knows one yet.
    expect((await signIn(t.app, "new.stylist@example.com")).res.status).toBe(401);

    const message = await mailTo(mail, "new.stylist@example.com");
    expect(message.subject).toContain("invited");
    const landing = await t.app.request(pathOf(linkIn(message)), {
      headers: { origin: "http://localhost:3000" },
    });
    expect(landing.status).toBe(302);
    const token = new URL(landing.headers.get("location") as string, "http://x").searchParams.get(
      "token",
    ) as string;
    const set = await json(t.app, "/api/auth/reset-password", "POST", {
      token,
      newPassword: "my own passphrase",
    });
    expect(set.status).toBe(200);

    const session = await signIn(t.app, "new.stylist@example.com", "my own passphrase");
    expect(session.res.status).toBe(200);
    const me = (await (await json(t.app, "/me", "GET", undefined, session.cookie)).json()) as {
      user: { role: string };
      staffId: string;
    };
    expect(me.user.role).toBe("staff");
    expect(me.staffId).toBe(body.staffId);

    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, "staff.create"));
    expect(JSON.stringify(audit[0]?.metadata)).toContain('"invited":true');
  });

  test("giving a password still works exactly as before, and nothing is emailed", async () => {
    const owner = await actor(t, "owner", "boss2@example.com");
    const res = await json(
      t.app,
      "/admin/staff-accounts",
      "POST",
      { email: "direct@example.com", name: "Direct", password: "owner picked this" },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    expect(((await res.json()) as { invited: boolean }).invited).toBe(false);
    expect((await signIn(t.app, "direct@example.com", "owner picked this")).res.status).toBe(200);
    await expectNoMailTo(mail, "direct@example.com");
  });

  test("an invitation is refused for an address that already has an account", async () => {
    const owner = await actor(t, "owner", "boss3@example.com");
    await actor(t, "client", "taken@example.com");
    const res = await json(
      t.app,
      "/admin/staff-accounts",
      "POST",
      { email: "taken@example.com", name: "Taken" },
      owner.cookie,
    );
    expect(res.status).toBe(409);
  });
});

describe("rate limiting of account emails", () => {
  test("the reset and verification endpoints sit behind the strict auth limiter", async () => {
    const limited = await setupApiTest({
      dbSuffix: "account_emails_rl",
      env: { AUTH_REQUIRE_EMAIL_VERIFICATION: "true", RATE_LIMIT_AUTH_MAX: "3" },
      deps: { emailProvider: new FakeEmailProvider() },
    });
    try {
      for (const path of [
        "/api/auth/request-password-reset",
        "/api/auth/send-verification-email",
      ]) {
        await limited.valkey.clear();
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
          const res = await json(limited.app, path, "POST", {
            email: "x@example.com",
            redirectTo: "/reset-password",
            callbackURL: "/account",
          });
          statuses.push(res.status);
        }
        expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
        expect(statuses.slice(3)).toEqual([429, 429]);
      }
    } finally {
      await limited.close();
    }
  });
});
