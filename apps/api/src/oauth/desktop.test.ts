import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  adminReviewsSchema,
  checkoutSchema,
  DESKTOP_CLIENT_ID,
  DESKTOP_SIGN_IN_SCOPE,
  dateShiftPreviewSchema,
  dateShiftResultSchema,
  dateShiftsResponseSchema,
  intakeAdminFormSchema,
  intakeFormSummariesSchema,
  intakeFormsSchema,
  intakeSubmissionSchema,
  intakeSubmissionsSchema,
  listServicesResponseSchema,
  reviewedBookingPolicySchema,
  reviewedSalonSettingsSchema,
  reviewedServiceListSchema,
  reviewedStaffAccessSchema,
  reviewPrivateSchema,
  staffAccountResponseSchema,
  stampProgramSchema,
  startedPaymentSchema,
  syncPullResponseSchema,
} from "@sob/contracts";
import { appointment, checkoutPayment, clientProfile, staffProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import { actor, cookieFrom, json, NOW, seedFixtures, setupApiTest } from "../../test/helpers";
import { authorizeFlow, ORIGIN, obtainTokens, tokenFor, tokenRequest } from "../../test/oauth";
import { redsysSignature } from "../payments/redsys";
import { desktopResource } from "./desktop";

let t: Awaited<ReturnType<typeof setupApiTest>>;
const bankSecret = "sq7HjrUOBfKmC576ILgskD5srU870gJ7"; // Official public test fixture.
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "oauth_desktop",
    deps: { syncHeartbeatMs: 20 },
    env: {
      RATE_LIMIT_OAUTH_MAX: "200",
      PAYMENT_PROVIDER: "redsys",
      REDSYS_MERCHANT_CODE: "999008881",
      REDSYS_TERMINAL: "001",
      REDSYS_SECRET_KEY: bankSecret,
      REDSYS_ENVIRONMENT: "test",
      REDSYS_BIZUM_ENABLED: "true",
    },
  });
  await t.reset();
  await seedFixtures(t.db);
});
afterAll(async () => t.close());

const resource = desktopResource(ORIGIN);
const redirectUri = "http://127.0.0.1:63281/callback";

async function tokens(role: "owner" | "client" | "staff", emailName: string = role) {
  const who = await actor(t, role, `${emailName}@example.com`);
  const flow = await authorizeFlow(t.app, {
    clientId: DESKTOP_CLIENT_ID,
    cookie: who.cookie,
    scope: `${DESKTOP_SIGN_IN_SCOPE} offline_access`,
    resource,
    redirectUri,
  });
  expect(flow.code).toBeString();
  const issued = await tokenRequest(t.app, {
    grant_type: "authorization_code",
    client_id: DESKTOP_CLIENT_ID,
    code: flow.code ?? "",
    code_verifier: flow.verifier,
    redirect_uri: redirectUri,
    resource,
  });
  expect(issued.res.status).toBe(200);
  expect(issued.body.refresh_token).toBeString();
  return {
    who,
    access: String(issued.body.access_token),
    refresh: String(issued.body.refresh_token),
  };
}

const request = (path: string, access: unknown) =>
  t.app.request(path, { headers: { authorization: `Bearer ${String(access)}` } });

test("desktop stamp programme and card access preserves role and method restrictions", async () => {
  const owner = await tokens("owner", "stamp-owner");
  const staff = await tokens("staff", "stamp-staff");
  const path = "/admin/rewards/stamps";
  const mutate = (url: string, method: string, access: string, input?: unknown) =>
    t.app.request(url, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const response = await request(`${path}/program`, owner.access);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const previous = stampProgramSchema.parse(await response.json());
  expect((await request(`${path}/program`, staff.access)).status).toBe(403);
  expect((await mutate(`${path}/program`, "POST", owner.access, {})).status).toBe(403);
  expect((await request(`${path}/cards`, owner.access)).status).toBe(403);
  expect((await request(`${path}/notices?summary=true`, owner.access)).status).toBe(200);
  expect((await request(`${path}/notices/read`, owner.access)).status).toBe(403);
  expect((await request(`${path}/bulk/preview?scope=all`, owner.access)).status).toBe(200);
  expect((await request(`${path}/bulk/preview?scope=all`, staff.access)).status).toBe(403);
  expect((await request(`${path}/bulk`, owner.access)).status).toBe(403);
  expect((await mutate(`${path}/bulk/preview`, "POST", owner.access, {})).status).toBe(403);
  expect((await mutate(`${path}/bulk`, "POST", owner.access, {})).status).toBe(400);

  expect((await mutate(`${path}/notices`, "POST", owner.access, {})).status).toBe(403);
  expect((await mutate(`${path}/notices/read`, "POST", owner.access, {})).status).toBe(400);

  expect((await request(`${path}/unknown`, owner.access)).status).toBe(403);
  expect(
    (
      await mutate(`${path}/program`, "PUT", owner.access, {
        ...previous,
        generation: "restored",
        existingCards: "keep",
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await mutate(`${path}/program`, "PUT", owner.access, {
        ...previous,
        existingCards: "keep",
      })
    ).status,
  ).toBe(200);
  expect((await mutate(`${path}/cards`, "POST", owner.access, {})).status).toBe(400);
});

test("desktop commissions authorize only reviewed writes and fence versions and generations", async () => {
  const owner = await tokens("owner", "commission-owner");
  const staff = await tokens("staff", "commission-staff");
  const colleague = await tokens("staff", "commission-colleague");
  const scope = "/admin/accounting/statement-scope";
  expect(await (await request(scope, staff.access)).json()).toMatchObject({
    staffId: staff.who.staffId,
    canChooseStaff: false,
  });
  const target = `/admin/accounting/staff/${colleague.who.staffId}`;
  const path = `${target}/statement?page=2&payoutPage=3`;
  const own = await request(`/admin/accounting/staff/${staff.who.staffId}/statement`, staff.access);
  expect(own.status).toBe(200);
  expect((await request(path, staff.access)).status).toBe(403);
  const policy = `${target}/policy/reviewed`;
  const payout = `${target}/payouts/reviewed`;
  const mutate = (url: string, method: string, access: string, input: unknown) =>
    t.app.request(url, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  expect((await request(policy, staff.access)).status).toBe(403);
  const manager = await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, staff.who.staffId ?? ""))
    .returning();
  expect(manager).toHaveLength(1);
  for (const access of [owner.access, staff.access]) {
    expect(await (await request(scope, access)).json()).toMatchObject({ canChooseStaff: true });
    const result = await request(path, access);
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(await result.json()).toMatchObject({
      staffId: colleague.who.staffId,
      pagination: { page: 2 },
      payoutPagination: { page: 3 },
    });
    expect(
      (
        await t.app.request(`${target}/payouts`, {
          method: "POST",
          headers: { authorization: `Bearer ${access}` },
        })
      ).status,
    ).toBe(403);
  }
  const review = await request(policy, staff.access);
  expect(review.status).toBe(200);
  const initial = (await review.json()) as { generation: string; version: number | null };
  const rates = {
    generation: initial.generation,
    version: initial.version,
    serviceBasisPoints: 1800,
    productBasisPoints: 1100,
  };
  expect((await mutate(policy, "PUT", staff.access, rates)).status).toBe(200);
  expect((await mutate(policy, "PUT", staff.access, rates)).status).toBe(409);
  const payment = {
    generation: "outdated-generation",
    actorUserId: staff.who.userId,
    amountCents: 100,
    reference: "External synthetic commission payout",
    idempotencyKey: crypto.randomUUID(),
  };
  const stale = await mutate(payout, "POST", staff.access, payment);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  const wrongActor = await mutate(payout, "POST", owner.access, {
    ...payment,
    generation: initial.generation,
  });
  expect(wrongActor.status).toBe(403);
});

test("the desktop proxy permits only reviewed catalogue operations and enforces live permissions", async () => {
  const owner = await tokens("owner", "catalog-standards-owner");
  const manager = await tokens("staff", "catalog-standards-manager");
  const path = "/admin/services/reviewed";
  expect((await request(path, manager.access)).status).toBe(403);
  if (!manager.who.staffId) throw new Error("Missing staff fixture");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, manager.who.staffId));
  const response = await request(path, manager.access);
  expect(response.status).toBe(200);
  const { generation, services } = reviewedServiceListSchema.parse(await response.json());
  const row = services.find((candidate) => candidate.active);
  if (!row?.version) throw new Error("Missing reviewed service fixture");
  const edit = {
    generation,
    version: row.version,
    service: { description: "Reviewed desktop update" },
  };
  const write = (url: string, method: string, access: string) =>
    t.app.request(url, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(edit),
    });
  expect((await write(path, "POST", owner.access)).status).toBe(403);
  expect((await write(`/admin/services/${row.id}`, "PATCH", owner.access)).status).toBe(403);
  const reviewed = `/admin/services/${row.id}/reviewed`;
  expect((await write(reviewed, "PUT", manager.access)).status).toBe(200);
  const resources = `/admin/services/${row.id}/resources/reviewed`;
  expect((await request(resources, manager.access)).status).toBe(200);
  expect((await write(resources, "PUT", owner.access)).status).toBe(403);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "professional" })
    .where(eq(staffProfile.id, manager.who.staffId));
  expect((await write(reviewed, "PUT", manager.access)).status).toBe(403);
  expect((await request(resources, manager.access)).status).toBe(403);
});

test("desktop inventory tools enforce read permissions without exposing costs or allowing writes", async () => {
  const owner = await tokens("owner", "inventory-tools-owner");
  const worker = await tokens("staff", "inventory-tools-staff");
  if (!worker.who.staffId) throw new Error("Missing staff fixture");
  const setAccess = (accessPreset: "restricted" | "receptionist") =>
    t.db.update(staffProfile).set({ accessPreset }).where(eq(staffProfile.id, worker.who.staffId!));
  await setAccess("restricted");
  const report = "/admin/inventory/products/report";
  const exportPath = "/admin/inventory/products/export";
  const paths = ["/admin/inventory/facets", report, exportPath];
  for (const path of paths) {
    const allowed = await request(path, owner.access);
    expect(allowed.status).toBe(200);
    await allowed.text();
    expect((await request(path, worker.access)).status).toBe(403);
    expect(
      (
        await t.app.request(path, {
          method: "POST",
          headers: { authorization: `Bearer ${owner.access}` },
        })
      ).status,
    ).toBe(403);
  }
  expect(await (await request(report, owner.access)).json()).toHaveProperty("valuation");
  await setAccess("receptionist");
  for (const path of paths) {
    const allowed = await request(path, worker.access);
    expect(allowed.status).toBe(200);
    await allowed.text();
  }
  expect(await (await request(report, worker.access)).json()).not.toHaveProperty("valuation");
  expect(await (await request(exportPath, worker.access)).text()).not.toContain("unit_cost_cents");
});

test("desktop staff provisioning is owner-only and preserves the existing profile", async () => {
  const owner = await tokens("owner", "provision-staff-owner");
  const member = await tokens("staff", "provision-staff-member");
  const [calendar] = await t.db
    .insert(staffProfile)
    .values({ displayName: "Imported calendar", accessPreset: "restricted" })
    .returning();
  if (!calendar) throw new Error("Missing existing calendar");
  const path = "/admin/staff-accounts";
  const body = {
    email: "provisioned-staff@example.com",
    name: "Imported calendar",
    password: "a synthetic passphrase",
    existingCalendar: {
      staffId: calendar.id,
      version: calendar.accessVersion,
      generation: "initial",
    },
  };
  const post = (access: string, payload: unknown = body) =>
    t.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  expect((await request(path, owner.access)).status).toBe(403);
  expect((await post(member.access)).status).toBe(403);
  expect(
    (await post(owner.access, { name: body.name, email: body.email, password: body.password }))
      .status,
  ).toBe(400);
  const created = await post(owner.access);
  expect(created.status).toBe(201);
  expect(staffAccountResponseSchema.parse(await created.json())).toMatchObject({
    staffId: calendar.id,
    invited: false,
    reviewedAccess: { access: { staffId: calendar.id, preset: "restricted" } },
  });
});

test("a Desktop owner can explicitly create a new staff calendar for the current database", async () => {
  const owner = await tokens("owner", "new-native-calendar-owner");
  const worker = await tokens("staff", "new-native-calendar-worker");
  const path = "/admin/staff-accounts";
  const body = {
    email: "new-native-calendar@example.com",
    name: "Synthetic staff login",
    displayName: "Synthetic bookable name",
    password: "a synthetic passphrase",
    newCalendar: { generation: t.config.syncReplicaGeneration },
  };
  const post = (payload: unknown, access = owner.access) =>
    t.app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  expect((await post(body, worker.access)).status).toBe(403);
  expect((await post({ ...body, newCalendar: { generation: "old-history" } })).status).toBe(409);
  expect(
    (
      await post({
        ...body,
        displayName: undefined,
        existingCalendar: {
          staffId: worker.who.staffId,
          version: 1,
          generation: t.config.syncReplicaGeneration,
        },
      })
    ).status,
  ).toBe(400);
  const missingEmail = await post({
    ...body,
    email: "native-calendar-missing-mail@example.com",
    password: undefined,
  });
  expect(missingEmail.status).toBe(503);
  expect(await missingEmail.json()).toMatchObject({ error: { code: "email_unavailable" } });
  const cursor = syncPullResponseSchema.parse(
    await (await request("/sync/pull", owner.access)).json(),
  ).headSeq;
  const response = await post(body);
  expect(response.status).toBe(201);
  const created = staffAccountResponseSchema.parse(await response.json());
  expect(created.reviewedAccess).toMatchObject({
    generation: t.config.syncReplicaGeneration,
    accountId: created.userId,
    accountEmail: body.email,
    access: { staffId: created.staffId, accountRole: "staff" },
  });
  expect((await post(body)).status).toBe(409);
  expect(
    await t.db.select().from(staffProfile).where(eq(staffProfile.userId, created.userId)),
  ).toMatchObject([{ id: created.staffId, displayName: body.displayName, active: true }]);
  const replica = syncPullResponseSchema.parse(
    await (await request(`/sync/pull?since=${cursor}`, owner.access)).json(),
  );
  expect(replica.changes).toContainEqual(
    expect.objectContaining({ entity: "staff", id: created.staffId, op: "upsert" }),
  );
});

test("reviewed team access uses the same owner policy in Desktop and Cloud", async () => {
  const owner = await tokens("owner", "team-access-review-owner");
  const member = await tokens("staff", "team-access-review-member");
  expect(member.who.staffId).toBeString();
  const path = `/admin/staff/${member.who.staffId}/access/reviewed`;
  const original = reviewedStaffAccessSchema.parse(
    await (await request(path, owner.access)).json(),
  );
  const change = {
    generation: original.generation,
    accountId: original.accountId,
    version: original.access.version,
    preset: "restricted",
  };
  const put = (body: unknown, access = owner.access, method = "PUT") =>
    t.app.request(path, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await request(path, member.access)).status).toBe(403);
  expect((await put(change, member.access)).status).toBe(403);
  expect((await put(change, owner.access, "PATCH")).status).toBe(403);
  expect((await put({ ...change, generation: "prior-history" })).status).toBe(409);
  expect((await put({ ...change, accountId: null })).status).toBe(409);
  const cursor = syncPullResponseSchema.parse(
    await (await request("/sync/pull", owner.access)).json(),
  ).headSeq;
  const saved = reviewedStaffAccessSchema.parse(await (await put(change)).json());
  expect(saved.access).toMatchObject({
    preset: "restricted",
    version: original.access.version + 1,
  });
  expect((await put(change)).status).toBe(409);
  expect(await (await request("/me", member.access)).json()).toMatchObject({
    accessPreset: "restricted",
  });
  const changePage = syncPullResponseSchema.parse(
    await (await request(`/sync/pull?since=${cursor}`, owner.access)).json(),
  );
  expect(changePage.changes).toContainEqual(
    expect.objectContaining({
      entity: "staff",
      id: member.who.staffId,
    }),
  );
  expect(await (await json(t.app, path, "GET", undefined, owner.who.cookie)).json()).toEqual(saved);
});

test("Desktop changes a linked role only against the current account and calendar review", async () => {
  const owner = await tokens("owner", "change-linked-role-owner");
  const member = await tokens("staff", "change-linked-role-member");
  const calendar = `/admin/staff/${member.who.staffId}`;
  const path = `${calendar}/account-role/reviewed`;
  const original = reviewedStaffAccessSchema.parse(
    await (await request(`${calendar}/access/reviewed`, owner.access)).json(),
  );
  const reviewed = {
    generation: original.generation,
    accountId: original.accountId,
    expectedEmail: original.accountEmail,
    expectedRole: original.access.accountRole,
    version: original.access.version,
    role: "client",
  };
  const put = (body: unknown, access = owner.access) =>
    t.app.request(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await put(reviewed, member.access)).status).toBe(403);
  expect((await request(path, owner.access)).status).toBe(403);
  expect((await put({ ...reviewed, generation: "earlier-database" })).status).toBe(409);
  expect((await put({ ...reviewed, accountId: owner.who.userId })).status).toBe(403);
  expect((await put({ ...reviewed, expectedRole: "client" })).status).toBe(400);
  expect((await put({ ...reviewed, expectedRole: "client", role: "owner" })).status).toBe(409);
  const other = await actor(t, "client", "role-other-account@example.com");
  expect((await put({ ...reviewed, accountId: other.userId })).status).toBe(409);
  expect((await put({ ...reviewed, expectedEmail: "older-address@example.com" })).status).toBe(409);
  const visit = Bun.randomUUIDv7();
  if (!other.clientId) throw new Error("Missing test client");
  await t.db.insert(appointment).values({
    id: visit,
    staffId: original.access.staffId,
    clientId: other.clientId,
    status: "booked",
    startsAt: new Date(NOW.getTime() + 3600000),
    endsAt: new Date(NOW.getTime() + 7200000),
  });
  const blocked = await put(reviewed);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "has_future_appointments" } });
  expect(await (await request(`${calendar}/access/reviewed`, owner.access)).json()).toEqual(
    original,
  );
  await t.db.update(appointment).set({ status: "cancelled" }).where(eq(appointment.id, visit));
  const demoted = await json(
    t.app,
    `/admin/staff/${original.access.staffId.toUpperCase()}/account-role/reviewed`,
    "PUT",
    reviewed,
    owner.who.cookie,
  );
  expect(demoted.status).toBe(200);
  const current = reviewedStaffAccessSchema.parse(await demoted.json());
  expect(current.access).toMatchObject({
    accountRole: "client",
    staffId: original.access.staffId,
    version: original.access.version + 1,
  });
  expect(
    await t.db.select().from(staffProfile).where(eq(staffProfile.id, current.access.staffId)),
  ).toMatchObject([{ active: false, userId: original.accountId }]);
  expect((await put(reviewed)).status).toBe(409);
  expect((await request("/sync/pull", member.access)).status).toBe(403);
  const promoted = await put({
    ...reviewed,
    expectedRole: current.access.accountRole,
    version: current.access.version,
    role: "staff",
  });
  expect(promoted.status).toBe(200);
  expect(
    await t.db.select().from(staffProfile).where(eq(staffProfile.id, current.access.staffId)),
  ).toMatchObject([{ active: true, userId: original.accountId }]);
  expect(await t.db.select().from(appointment).where(eq(appointment.id, visit))).toMatchObject([
    { id: visit, status: "cancelled", staffId: original.access.staffId },
  ]);
});

test("an owner can review and promote an existing verified account without a calendar", async () => {
  const owner = await tokens("owner", "unlinked-roles-owner");
  const staff = await tokens("staff", "unlinked-roles-staff");
  const email = "unlinked-target@example.com";
  const member = await actor(t, "client", email);
  const send = (path: string, method: string, body: unknown, access = owner.access) =>
    t.app.request(path, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const lookup = "/admin/accounts/lookup";
  const change = "/admin/accounts/role/reviewed";
  expect((await send(lookup, "POST", { email }, staff.access)).status).toBe(403);
  expect((await json(t.app, lookup, "POST", { email }, staff.who.cookie)).status).toBe(403);
  expect((await request(lookup, owner.access)).status).toBe(403);
  expect((await send(lookup, "POST", { email: "unlinked-target" })).status).toBe(400);
  expect((await send(lookup, "POST", { email: staff.who.email })).status).toBe(404);
  const found = await send(lookup, "POST", { email: email.toUpperCase() });
  expect(found.status).toBe(200);
  let review = (await found.json()) as Record<string, unknown>;
  expect(review).toMatchObject({
    userId: member.userId,
    email,
    role: "client",
    emailVerified: true,
  });
  const mutation = {
    userId: member.userId,
    generation: review.generation,
    revision: review.revision,
    role: "staff",
  };
  expect((await send(change, "PUT", mutation, staff.access)).status).toBe(403);
  expect((await send(change, "PUT", { ...mutation, generation: "previous-database" })).status).toBe(
    409,
  );
  expect((await send(change, "PUT", { ...mutation, userId: owner.who.userId })).status).toBe(403);
  await t.db.update(user).set({ role: "owner" }).where(eq(user.id, member.userId));
  await t.db.update(user).set({ role: "client" }).where(eq(user.id, member.userId));
  expect((await send(change, "PUT", mutation)).status).toBe(409);
  await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, member.userId));
  review = (await (await send(lookup, "POST", { email })).json()) as Record<string, unknown>;
  const blocked = await send(change, "PUT", { ...mutation, revision: review.revision });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "invalid_state" } });
  expect(
    await t.db.select().from(staffProfile).where(eq(staffProfile.userId, member.userId)),
  ).toHaveLength(0);
  await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, member.userId));
  review = (await (await send(lookup, "POST", { email })).json()) as Record<string, unknown>;
  const current = { ...mutation, revision: review.revision };
  const confirmations = await Promise.all([
    send(change, "PUT", current),
    json(t.app, change, "PUT", current, owner.who.cookie),
  ]);
  expect(confirmations.map(({ status }) => status).sort()).toEqual([200, 409]);
  const promoted = confirmations.find(({ status }) => status === 200);
  if (!promoted) throw new Error("No role was saved");
  const result = (await promoted.json()) as Record<string, unknown>;
  expect(result).toMatchObject({ userId: member.userId, role: "staff", clientId: member.clientId });
  expect(result.staffId).toBeString();
  expect((await send(change, "PUT", mutation)).status).toBe(409);
  expect((await send(lookup, "POST", { email })).status).toBe(404);
});

test("native booking protection shares the Cloud policy and only opted-in replicas see refreshes", async () => {
  const owner = await tokens("owner", "booking-policy-desktop-owner");
  const staff = await tokens("staff", "booking-policy-desktop-staff");
  const path = "/admin/settings/booking-policy/reviewed";
  const original = reviewedBookingPolicySchema.parse(
    await (await request(path, owner.access)).json(),
  );
  const put = (body: unknown, token = owner.access) =>
    t.app.request(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const cursor = syncPullResponseSchema.parse(
    await (await request("/sync/pull", owner.access)).json(),
  ).headSeq;
  const edited = {
    ...original,
    policy: { ...original.policy, holdMinutes: original.policy.holdMinutes === 25 ? 20 : 25 },
  };
  expect((await t.app.request(path)).status).toBe(401);
  expect((await request(path, staff.access)).status).toBe(403);
  expect((await put(edited, staff.access)).status).toBe(403);
  const staleGeneration = await put({ ...edited, generation: "restored-test-history" });
  expect(staleGeneration.status).toBe(409);
  expect(await staleGeneration.json()).toMatchObject({
    error: { code: "sync_generation_changed" },
  });
  const saved = await put(edited);
  expect(saved.status).toBe(200);
  const version = reviewedBookingPolicySchema.parse(await saved.json()).policy.version;
  try {
    expect(version).toBe(original.policy.version + 1);
    expect(
      await (
        await json(t.app, "/admin/settings/booking-policy", "GET", undefined, owner.who.cookie)
      ).json(),
    ).toMatchObject({ ...edited.policy, version });
    const stale = await put(edited);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "version_conflict" } });
    const refresh = async (query: string) =>
      syncPullResponseSchema.parse(
        await (await request(`/sync/pull?since=${cursor}${query}`, owner.access)).json(),
      );
    expect((await refresh("")).refresh ?? []).not.toContain("booking_policy");
    expect((await refresh("&bookingPolicy=1")).refresh).toContain("booking_policy");
  } finally {
    expect(
      (
        await json(
          t.app,
          "/admin/settings/booking-policy",
          "PUT",
          { ...original.policy, version },
          owner.who.cookie,
        )
      ).status,
    ).toBe(200);
  }
});

test("desktop owner settings share Cloud changes and reject stale edits atomically", async () => {
  const path = "/admin/settings/desktop";
  const owner = await tokens("owner", "salon-config-owner");
  const staff = await tokens("staff", "salon-config-staff");
  const read = async () =>
    reviewedSalonSettingsSchema.parse(await (await request(path, owner.access)).json());
  const native = (expectedRevision: string, changes: unknown, access = owner.access) =>
    t.app.request(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision, changes }),
    });
  const web = (changes: unknown) =>
    json(t.app, "/admin/settings", "PATCH", changes, owner.who.cookie);
  const saved = await read();
  const changed = saved.minNoticeMinutes === 35 ? 40 : 35;
  expect((await t.app.request(path)).status).toBe(401);
  expect((await request(path, staff.access)).status).toBe(403);
  expect((await native(saved.revision, { minNoticeMinutes: changed }, staff.access)).status).toBe(
    403,
  );
  try {
    const edited = {
      onlineBookingEnabled: !saved.onlineBookingEnabled,
      reminderFirstLeadMinutes: null,
    };
    expect(await (await native(saved.revision, edited)).json()).toMatchObject(edited);
    expect((await native(saved.revision, edited)).status).toBe(200);
    expect(
      await (await json(t.app, "/admin/settings", "GET", undefined, owner.who.cookie)).json(),
    ).toMatchObject(edited);
    expect((await web({ onlineBookingEnabled: saved.onlineBookingEnabled })).status).toBe(200);
    const reopened = await read();
    const retry = await native(saved.revision, edited);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: "version_conflict" } });
    expect(await read()).toEqual(reopened);
    expect(
      (
        await native(saved.revision, {
          onlineBookingEnabled: saved.onlineBookingEnabled,
          minNoticeMinutes: changed,
        })
      ).status,
    ).toBe(409);
    expect(await read()).toEqual(reopened);
    const accepted = await native(reopened.revision, {
      minNoticeMinutes: changed,
      timezone: "europe/madrid",
    });
    expect(await accepted.json()).toMatchObject({
      minNoticeMinutes: changed,
      onlineBookingEnabled: saved.onlineBookingEnabled,
      reminderFirstLeadMinutes: null,
      timezone: "Europe/Madrid",
    });
  } finally {
    expect(
      (
        await web({
          minNoticeMinutes: saved.minNoticeMinutes,
          onlineBookingEnabled: saved.onlineBookingEnabled,
          reminderFirstLeadMinutes: saved.reminderFirstLeadMinutes,
          timezone: saved.timezone,
        })
      ).status,
    ).toBe(200);
  }
});

async function assertHostedReceiptPayment(receiptId: string, cookie: string, access: string) {
  const path = `/admin/commerce/checkouts/${receiptId}`;
  const response = await json(
    t.app,
    `${path}/payments`,
    "POST",
    { method: "redsys_bizum", amountCents: 1200, idempotencyKey: crypto.randomUUID() },
    cookie,
  );
  expect(response.status).toBe(201);
  const { payment, form } = startedPaymentSchema.parse(await response.json());
  expect(payment.status).toBe("pending");
  expect(form?.action).toBe("https://sis-t.redsys.es:25443/sis/realizarPago");
  const nativeReceipt = async () =>
    checkoutSchema.parse(await (await request(path, access)).json());
  expect((await nativeReceipt()).paidCents).toBe(0);
  const cursor = syncPullResponseSchema.parse(
    await (await request("/sync/pull", access)).json(),
  ).nextCursor;

  const order = payment.order;
  if (!order) throw new Error("Expected a pending sandbox bank order");
  const merchantParameters = Buffer.from(
    JSON.stringify({
      Ds_Order: order,
      Ds_Amount: "1200",
      Ds_Currency: "978",
      Ds_MerchantCode: "999008881",
      Ds_Terminal: "1",
      Ds_Response: "0000",
      Ds_TransactionType: "0",
    }),
  ).toString("base64url");
  const confirmed = await t.app.request("/payments/redsys/notify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      Ds_MerchantParameters: merchantParameters,
      Ds_SignatureVersion: "HMAC_SHA512_V2",
      Ds_Signature: redsysSignature(bankSecret, order, merchantParameters),
    }),
  });
  expect(confirmed.status).toBe(200);
  const changes = await request(`/sync/pull?since=${cursor}`, access);
  expect(syncPullResponseSchema.parse(await changes.json()).refresh).toContain("commerce");
  expect(await nativeReceipt()).toMatchObject({ status: "paid", paidCents: 1200, balanceCents: 0 });
}
const reportPath = "/admin/reports/summary?from=2026-11-18&to=2026-11-18";
const salesReportPath = "/admin/accounting/sales?from=2026-11-18&to=2026-11-18";
const clientReportPath = "/admin/reports/clients?from=2026-11-18&to=2026-11-18";
const outcomeParams = "?from=2026-11-18&to=2026-11-18&status=no_show";
const outcomePath = `/admin/reports/outcomes${outcomeParams}`;
const outcomeExportPath = `/admin/reports/outcomes/export${outcomeParams}`;

test("desktop reconciliation is scoped, waits for the bank and updates the shared receipt", async () => {
  const owner = await tokens("owner", "bank-review-owner");
  const staff = await tokens("staff", "bank-review-staff");
  const sale = await json(
    t.app,
    "/admin/commerce/checkouts",
    "POST",
    {
      lines: [
        {
          kind: "custom",
          description: "Synthetic POS receipt",
          unitAmountCents: 1800,
          quantity: 1,
        },
      ],
      idempotencyKey: crypto.randomUUID(),
    },
    owner.who.cookie,
  );
  expect(sale.status).toBe(201);
  const receipt = checkoutSchema.parse(await sale.json());
  const path = `/admin/commerce/checkouts/${receipt.id}`;
  const started = await json(
    t.app,
    `${path}/payments`,
    "POST",
    {
      method: "redsys_card",
      amountCents: 1800,
      idempotencyKey: crypto.randomUUID(),
    },
    owner.who.cookie,
  );
  expect(started.status).toBe(201);
  const { payment } = startedPaymentSchema.parse(await started.json());
  const reconcile = (access: string, reference: string) =>
    t.app.request(`/admin/commerce/payments/${payment.id}/reconcile`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ outcome: "succeeded", reference }),
    });
  expect((await reconcile(owner.access, "TEST-REF-1800")).status).toBe(409);
  await t.db
    .update(checkoutPayment)
    .set({ updatedAt: new Date(Date.now() - 120_000) })
    .where(eq(checkoutPayment.id, payment.id));
  expect((await reconcile(staff.access, "TEST-REF-1800")).status).toBe(403);
  expect((await reconcile(owner.access, "short")).status).toBe(400);
  expect((await reconcile(owner.access, "TEST-REF-1800")).status).toBe(200);
  expect((await reconcile(owner.access, "TEST-REF-1800")).status).toBe(409);
  const confirmed = await json(t.app, path, "GET", undefined, owner.who.cookie);
  expect(checkoutSchema.parse(await confirmed.json())).toMatchObject({
    status: "paid",
    paidCents: 1800,
    balanceCents: 0,
    payments: [{ id: payment.id, status: "succeeded" }],
  });
});

test("a desktop owner can review and replay a dated shift without broader staff access", async () => {
  const { access } = await tokens("owner", "dated-shifts-owner");
  const [member] = await t.db
    .select()
    .from(staffProfile)
    .where(eq(staffProfile.displayName, "Ana"));
  if (!member) throw new Error("Missing shift member");
  const date = "2026-03-10";
  const path = `/admin/staff/${member.id}/date-shifts`;
  const headers = { authorization: `Bearer ${access}`, "content-type": "application/json" };
  const read = await request(`${path}?from=${date}&to=${date}`, access);
  expect(read.status).toBe(200);
  expect(dateShiftsResponseSchema.parse(await read.json()).days[0]?.ranges).toBeNull();
  expect((await request(`/admin/staff/${member.id}/access`, access)).status).toBe(403);
  expect((await request(`${path}/preview`, access)).status).toBe(403);
  expect((await t.app.request(path, { method: "DELETE", headers })).status).toBe(403);
  const post = (route: string, body: object) =>
    t.app.request(route, { method: "POST", headers, body: JSON.stringify(body) });
  const selection = { mode: "edit", changes: [{ date, ranges: [] }] };
  const { access: staff } = await tokens("staff", "dated-shifts-staff");
  expect(
    (
      await t.app.request(`${path}/preview`, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${staff}` },
        body: JSON.stringify(selection),
      })
    ).status,
  ).toBe(403);
  const proposed = await post(`${path}/preview`, selection);
  expect(proposed.status).toBe(200);
  const review = dateShiftPreviewSchema.parse(await proposed.json());
  expect(review.changes[0]).toMatchObject({ previous: { ranges: null }, next: { ranges: [] } });
  const input = { selection, reviewHash: review.reviewHash, idempotencyKey: Bun.randomUUIDv7() };
  const saved = await post(path, input);
  expect(saved.status).toBe(201);
  expect(dateShiftResultSchema.parse(await saved.json())).toMatchObject({
    replayed: false,
    days: [{ date, ranges: [], version: 1 }],
  });
  const replayed = await post(path, input);
  expect(replayed.status).toBe(201);
  expect(dateShiftResultSchema.parse(await replayed.json())).toMatchObject({
    replayed: true,
    days: [{ date, ranges: [], version: 1 }],
  });
});

test("desktop form administration uses live permissions and versioned, immutable publication", async () => {
  const owner = await tokens("owner", "form-admin-owner");
  const staff = await tokens("staff", "form-admin-staff");
  const directory = "/admin/intake-forms";
  const desktop = (path: string, method: string, body?: object, access = owner.access) =>
    t.app.request(path, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  expect(await (await request("/me/desktop-workspaces", owner.access)).json()).toMatchObject({
    workspaces: expect.arrayContaining(["intake_forms"]),
  });
  const professionalMenu = (await (
    await request("/me/desktop-workspaces", staff.access)
  ).json()) as {
    workspaces: string[];
  };
  expect(professionalMenu.workspaces).not.toContain("intake_forms");
  expect((await desktop(directory, "GET", undefined, staff.access)).status).toBe(403);
  expect((await desktop(directory, "DELETE")).status).toBe(403);
  const definition = {
    kind: "waiver",
    title: "Synthetic consent",
    description: "First line\nSecond line",
    fields: [
      { id: crypto.randomUUID(), label: "I agree", kind: "consent", required: true },
      { id: crypto.randomUUID(), label: "Count", kind: "number", minimum: 0, maximum: 10 },
    ],
    requiredAtBooking: true,
    allowTeamResponses: true,
    allServices: true,
    serviceIds: [],
  };
  const input = { idempotencyKey: crypto.randomUUID(), definition };
  expect((await desktop(directory, "POST", input, staff.access)).status).toBe(403);
  const created = await desktop(directory, "POST", input);
  expect(created.status).toBe(201);
  expect(created.headers.get("cache-control")).toBe("private, no-store");
  const draft = intakeAdminFormSchema.parse(await created.json());
  const retry = await desktop(directory, "POST", input);
  expect(intakeAdminFormSchema.parse(await retry.json()).id).toBe(draft.id);

  const path = `${directory}/${draft.id}`;
  expect((await desktop(directory, "GET")).status).toBe(403);
  const summaryPath = `${directory}?view=summary`;
  const summary = await desktop(summaryPath, "GET");
  expect(summary.status).toBe(200);
  expect(summary.headers.get("cache-control")).toBe("private, no-store");
  expect(intakeFormSummariesSchema.parse(await summary.json())).toEqual({
    forms: [
      {
        id: draft.id,
        title: definition.title,
        active: false,
        version: draft.version,
        publishedNumber: null,
      },
    ],
  });
  expect((await desktop(summaryPath, "GET", undefined, staff.access)).status).toBe(403);
  expect((await desktop(path, "GET", undefined, staff.access)).status).toBe(403);
  expect(intakeAdminFormSchema.parse(await (await desktop(path, "GET")).json())).toEqual(draft);
  expect((await desktop(`${path}/publish`, "PUT", { version: draft.version })).status).toBe(403);
  const published = intakeAdminFormSchema.parse(
    await (await desktop(`${path}/publish`, "POST", { version: draft.version })).json(),
  );
  expect(published).toMatchObject({ active: true, published: { number: 1, definition } });
  expect((await desktop(path, "PUT", { version: draft.version, definition })).status).toBe(409);

  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.userId, staff.who.userId));
  const changed = { ...definition, title: "Updated draft" };
  const saved = intakeAdminFormSchema.parse(
    await (
      await desktop(
        path,
        "PUT",
        {
          version: published.version,
          definition: changed,
        },
        staff.access,
      )
    ).json(),
  );
  expect(saved).toMatchObject({ draft: changed, published: { definition } });
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "professional" })
    .where(eq(staffProfile.userId, staff.who.userId));
  expect(
    (await desktop(`${path}/archive`, "POST", { version: saved.version }, staff.access)).status,
  ).toBe(403);
  const archived = intakeAdminFormSchema.parse(
    await (await desktop(`${path}/archive`, "POST", { version: saved.version })).json(),
  );
  expect(archived).toMatchObject({ active: false, draft: changed, published: { definition } });
  const cloud = await json(t.app, directory, "GET", undefined, owner.who.cookie);
  expect(
    intakeFormsSchema.parse(await cloud.json()).forms.find((form) => form.id === draft.id),
  ).toEqual(archived);
  expect((await desktop("/intake/submissions/" + draft.id, "GET")).status).toBe(403);
});

test("desktop private response history stays bound to the reviewed client and immutable revision", async () => {
  const owner = await tokens("owner", "intake-records-owner");
  const staff = await tokens("staff", "intake-records-professional");
  const post = (path: string, data: object, access = staff.access, method = "POST") =>
    t.app.request(path, {
      method,
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  const [source, survivor, foreign] = await t.db
    .insert(clientProfile)
    .values([
      { name: "Synthetic same subject" },
      { name: "Synthetic same subject" },
      { name: "Synthetic different subject" },
    ])
    .returning({ id: clientProfile.id });
  if (!source || !survivor || !foreign) throw new Error("Missing fixture subjects");
  const record = (id: string) => `/admin/clients/${id}/intake`;
  const internal = await json(
    t.app,
    "/admin/services",
    "POST",
    {
      name: "Synthetic team-only intake service",
      durationMinutes: 30,
      priceCents: 1500,
      currency: "EUR",
      onlineBooking: false,
    },
    owner.who.cookie,
  );
  expect(internal.status).toBe(201);
  const internalId = ((await internal.json()) as { id: string }).id;
  const catalog = await request(`${record(source.id)}/catalog`, staff.access);
  expect(catalog.status).toBe(200);
  expect(catalog.headers.get("cache-control")).toBe("private, no-store");
  expect(listServicesResponseSchema.parse(await catalog.json()).services).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: internalId, onlineBooking: false })]),
  );
  expect((await request(`${record(source.id)}/catalog`, staff.access)).status).toBe(200);
  const directory = "/admin/intake-forms";
  const field = crypto.randomUUID();
  const definition = {
    title: "Synthetic original wording",
    allowTeamResponses: true,
    fields: [{ id: field, label: "Original numeric question", kind: "number", required: true }],
  };
  const form = intakeAdminFormSchema.parse(
    await (
      await post(directory, { definition, idempotencyKey: crypto.randomUUID() }, owner.access)
    ).json(),
  );
  const published = intakeAdminFormSchema.parse(
    await (
      await post(`${directory}/${form.id}/publish`, { version: form.version }, owner.access)
    ).json(),
  );
  if (!published.published) throw new Error("Missing synthetic publication");
  const packet = {
    idempotencyKey: crypto.randomUUID(),
    revisionId: published.published.id,
    confirmation: true,
    answers: { [field]: 0 },
  };
  const first = await post(record(source.id), packet);
  expect(first.status).toBe(201);
  expect(first.headers.get("cache-control")).toBe("private, no-store");
  const saved = intakeSubmissionSchema.parse(await first.json());
  expect(saved).toMatchObject({ source: "team", answers: { [field]: 0 } });
  expect(
    intakeSubmissionSchema.parse(await (await post(record(source.id), packet)).json()).id,
  ).toBe(saved.id);
  for (let index = 0; index < 20; index++) {
    expect(
      (await post(record(source.id), { ...packet, idempotencyKey: crypto.randomUUID() })).status,
    ).toBe(201);
  }
  const beforeMerge = await request(record(source.id), staff.access);
  expect(beforeMerge.headers.get("cache-control")).toBe("private, no-store");
  const newest = intakeSubmissionsSchema.parse(await beforeMerge.json());
  expect(newest.submissions).toHaveLength(20);
  expect(newest.nextCursor).not.toBeNull();
  expect(newest.submissions.every((entry) => !Object.hasOwn(entry, "answers"))).toBe(true);
  const older = intakeSubmissionsSchema.parse(
    await (await request(`${record(source.id)}?before=${newest.nextCursor}`, staff.access)).json(),
  );
  expect(older.submissions).toHaveLength(1);
  expect(older.nextCursor).toBeNull();

  const beforeMergeCursor = syncPullResponseSchema.parse(
    await (await request("/sync/pull", staff.access)).json(),
  ).headSeq;
  const merge = { sourceId: source.id, targetId: survivor.id };
  const preview = await json(
    t.app,
    "/admin/clients/merge/preview",
    "POST",
    merge,
    owner.who.cookie,
  );
  expect(preview.status).toBe(200);
  const { reviewHash } = (await preview.json()) as { reviewHash: string };
  expect(
    (
      await json(
        t.app,
        "/admin/clients/merge",
        "POST",
        {
          ...merge,
          reviewHash,
          confirmedSamePerson: true,
          idempotencyKey: crypto.randomUUID(),
        },
        owner.who.cookie,
      )
    ).status,
  ).toBe(201);
  expect(
    (await post(record(source.id), { ...packet, idempotencyKey: crypto.randomUUID() })).status,
  ).toBe(409);
  const mergedFeed = syncPullResponseSchema.parse(
    await (
      await request(`/sync/pull?since=${beforeMergeCursor}&intakeViews=1`, staff.access)
    ).json(),
  );
  expect(mergedFeed.refresh).toContain("intake_records");
  const mergedHistory = intakeSubmissionsSchema.parse(
    await (await request(record(survivor.id), staff.access)).json(),
  );
  expect(mergedHistory.submissions).toHaveLength(20);
  expect(JSON.stringify(mergedFeed)).not.toContain(saved.id);
  expect((await request(`${record(foreign.id)}/${saved.id}`, staff.access)).status).toBe(404);
  expect(
    (await post(`${record(survivor.id)}/${saved.id}`, {}, staff.access, "DELETE")).status,
  ).toBe(403);
  expect((await request(`/intake/submissions/${saved.id}`, staff.access)).status).toBe(403);
  expect(
    (await post(`${directory}/${form.id}/archive`, { version: published.version }, owner.access))
      .status,
  ).toBe(200);
  const detail = `${record(survivor.id)}/${saved.id}`;
  const response = await request(detail, staff.access);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(intakeSubmissionSchema.parse(await response.json())).toEqual(saved);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.userId, staff.who.userId));
  expect((await request(detail, staff.access)).status).toBe(403);
  expect((await request(record(survivor.id), staff.access)).status).toBe(403);
});

test("owner PKCE tokens authorize sync, refresh and stop working after revocation", async () => {
  const { who, access, refresh } = await tokens("owner");
  const profile = await request("/me", access);
  expect(profile.status).toBe(200);
  expect(await profile.json()).toMatchObject({ user: { id: who.userId, role: "owner" } });
  expect((await request("/sync/pull", access)).status).toBe(200);
  expect((await request("/admin/staff", access)).status).toBe(403);
  const stream = await request("/sync/stream", access);
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
  expect((await request("/mcp", access)).status).toBe(401);
  const { tokens: mcp } = await tokenFor(t, who, "mcp:read");
  expect((await request("/sync/pull", mcp.access_token)).status).toBe(401);

  const renewed = await tokenRequest(t.app, {
    grant_type: "refresh_token",
    client_id: DESKTOP_CLIENT_ID,
    refresh_token: refresh,
    resource,
  });
  expect(renewed.res.status).toBe(200);
  expect(renewed.body.refresh_token).not.toBe(refresh);
  expect((await request("/sync/pull", renewed.body.access_token)).status).toBe(200);
  const revoke = await t.app.request(`/me/connections/${DESKTOP_CLIENT_ID}`, {
    method: "DELETE",
    headers: { cookie: who.cookie, origin: ORIGIN },
  });
  expect(revoke.status).toBe(204);
  expect((await request("/sync/pull", renewed.body.access_token)).status).toBe(401);
});

test("a customer cannot use desktop endpoints even with an approved authorization", async () => {
  const { access } = await tokens("client");
  expect((await request("/me", access)).status).toBe(403);
  expect((await request("/sync/pull", access)).status).toBe(403);
  expect((await request(reportPath, access)).status).toBe(403);
  expect((await request(salesReportPath, access)).status).toBe(403);
  expect((await request(outcomeExportPath, access)).status).toBe(403);
  expect((await request("/admin/reviews/requests", access)).status).toBe(403);
});

test("desktop review invitations and moderation require the live management permission", async () => {
  const { who, access } = await tokens("staff");
  const requests = "/admin/reviews/requests";
  const visit = Bun.randomUUIDv7();
  const send = () =>
    t.app.request(`${requests}/${visit}/email`, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: "{}",
    });
  expect((await request(requests, access)).status).toBe(403);
  expect((await request("/admin/reviews", access)).status).toBe(403);
  expect((await send()).status).toBe(403);
  const [manager] = await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.userId, who.userId))
    .returning({ id: staffProfile.id });
  expect((await request(requests, access)).status).toBe(200);
  expect((await send()).status).toBe(400);
  expect((await request(`/admin/reviews/${visit}/social`, access)).status).toBe(403);
  const customer = await actor(t, "client", "native-reviewer@example.test");
  await t.db.insert(appointment).values({
    id: visit,
    staffId: manager!.id,
    clientId: customer.clientId!,
    status: "completed",
    startsAt: new Date(NOW.getTime() - 7200000),
    endsAt: new Date(NOW.getTime() - 3600000),
  });
  const posted = await json(
    t.app,
    "/me/reviews",
    "POST",
    {
      appointmentId: visit,
      idempotencyKey: Bun.randomUUIDv7(),
      publicName: "Native reviewer",
      rating: 4,
      body: "Synthetic feedback",
      publicationConfirmed: true,
    },
    customer.cookie,
  );
  expect(posted.status).toBe(201);
  const review = reviewPrivateSchema.parse(await posted.json());
  const page = adminReviewsSchema.parse(
    await (await request("/admin/reviews?status=pending", access)).json(),
  );
  expect(page.reviews.find(({ id }) => id === review.id)?.body).toBe("Synthetic feedback");
  const update = (endpoint: string, body: unknown) =>
    t.app.request(`/admin/reviews/${review.id}/${endpoint}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const beforeModeration = syncPullResponseSchema.parse(
    await (await request("/sync/pull?limit=1", access)).json(),
  ).headSeq;
  const published = reviewPrivateSchema.parse(
    await (await update("moderation", { status: "published", version: review.version })).json(),
  );
  expect(published.status).toBe("published");
  const invalidation = syncPullResponseSchema.parse(
    await (await request(`/sync/pull?since=${beforeModeration}&reviewRequests=1`, access)).json(),
  );
  expect(invalidation.refresh).toEqual(["review_requests"]);
  expect(invalidation.changes).toEqual([]);
  expect((await update("reply", { reply: "Old draft", version: review.version })).status).toBe(409);
  const reply = "Thank you.\nWe are glad you visited.";
  const answered = reviewPrivateSchema.parse(
    await (await update("reply", { reply, version: published.version })).json(),
  );
  expect(answered.reply).toBe(reply);
  const hidden = reviewPrivateSchema.parse(
    await (
      await update("moderation", {
        status: "hidden",
        reason: "Synthetic moderation reason",
        version: answered.version,
      })
    ).json(),
  );
  expect(hidden).toMatchObject({
    status: "hidden",
    moderationReason: "Synthetic moderation reason",
  });
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "receptionist" })
    .where(eq(staffProfile.id, manager!.id));
  expect((await request("/admin/reviews", access)).status).toBe(403);
  expect(
    (await update("moderation", { status: "published", version: hidden.version })).status,
  ).toBe(403);
});

test("linked devices renew independently and can be revoked from either client", async () => {
  const who = await actor(t, "owner", "devices@example.com");
  const other = await actor(t, "owner", "other-devices@example.com");
  const webHeaders = { cookie: who.cookie, origin: ORIGIN };
  const list = () => t.app.request("/me/desktop-devices", { headers: webHeaders });
  const endpoint = (action: string, body: unknown, bearer?: string) =>
    t.app.request(`/api/auth/desktop/${action}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(bearer && { authorization: `Bearer ${bearer}` }),
      },
      body: JSON.stringify(body),
    });

  async function connect(label: string) {
    const { tokens: initial } = await obtainTokens(t.app, {
      clientId: DESKTOP_CLIENT_ID,
      cookie: who.cookie,
      scope: DESKTOP_SIGN_IN_SCOPE,
      resource,
      redirectUri,
    });
    expect(initial.refresh_token).toBeUndefined();
    expect((await request("/me", initial.access_token)).status).toBe(401);
    const pair = generateKeyPairSync("ed25519");
    const publicKey = pair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url");
    const linked = await endpoint("link", { label, publicKey }, initial.access_token);
    expect(linked.status).toBe(200);
    const { deviceId } = (await linked.json()) as { deviceId: string };
    expect(
      await (await endpoint("link", { label, publicKey }, initial.access_token)).json(),
    ).toEqual({ deviceId });
    const wrongKey = generateKeyPairSync("ed25519")
      .publicKey.export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url");
    expect(
      (await endpoint("link", { label, publicKey: wrongKey }, initial.access_token)).status,
    ).toBe(403);

    return {
      id: deviceId,
      proof(
        action: "token" | "revoke" | "browser-ticket",
        issuedAt = Math.floor(Date.now() / 1000),
        binding: string[] = [],
      ) {
        const nonce = randomBytes(32).toString("base64url");
        const bytes = Buffer.from(
          ["citame-desktop-v1", resource, deviceId, action, issuedAt, nonce, ...binding].join("\n"),
        );
        return {
          deviceId,
          issuedAt,
          nonce,
          signature: sign(null, bytes, pair.privateKey).toString("base64url"),
        };
      },
    };
  }

  const first = await connect("Recepción · Linux");
  const second = await connect("Despacho · Mac");
  const browserOrigin = "http://127.0.0.1:54321";
  const calendar = { date: "2026-11-18", view: "week" };
  const issueBrowser = async () => {
    const response = await endpoint("browser-ticket", {
      proof: first.proof("browser-ticket", undefined, [
        browserOrigin,
        calendar.date,
        calendar.view,
        "",
      ]),
      origin: browserOrigin,
      calendar,
    });
    expect(response.status).toBe(200);
    const { ticket } = (await response.json()) as { ticket: string };
    return ticket;
  };
  const redeemBrowser = (ticket: string, origin = browserOrigin) =>
    t.app.request("/api/auth/desktop/browser", {
      method: "POST",
      headers: {
        origin,
        cookie: other.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ ticket }).toString(),
    });
  const browserTicket = await issueBrowser();
  const cookieTicketRequest = (origin: string) =>
    t.app.request("/api/auth/desktop/browser-ticket", {
      method: "POST",
      headers: { origin, cookie: who.cookie, "content-type": "application/json" },
      body: JSON.stringify({ origin: browserOrigin, calendar }),
    });
  expect((await cookieTicketRequest(browserOrigin)).status).toBe(403);
  const cookieTicket = await cookieTicketRequest(ORIGIN);
  expect(cookieTicket.status).toBe(200);
  const legacyBrowser = await redeemBrowser(
    ((await cookieTicket.json()) as { ticket: string }).ticket,
  );
  expect(legacyBrowser.status).toBe(303);
  expect((await redeemBrowser(browserTicket, ORIGIN)).status).toBe(403);
  expect((await redeemBrowser(browserTicket, "http://127.0.0.1:54322")).status).toBe(401);
  const browser = await redeemBrowser(browserTicket);
  expect(browser.status).toBe(303);
  expect(browser.headers.get("location")).toBe("/admin/calendar?date=2026-11-18&view=week");
  const browserCookie = browser.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
  expect(browserCookie).toContain("session_token=");
  const browserUser = await t.app.request("/me", { headers: { cookie: browserCookie } });
  expect(await browserUser.json()).toMatchObject({ user: { id: who.userId, role: "owner" } });
  expect((await redeemBrowser(browserTicket)).status).toBe(401);
  const workspaceRequest = {
    origin: browserOrigin,
    workspace: "inventory",
    proof: first.proof("browser-ticket", undefined, [browserOrigin, "workspace", "inventory"]),
  };
  expect(
    (await endpoint("browser-ticket", { ...workspaceRequest, workspace: "settings" })).status,
  ).toBe(401);
  expect(
    (
      await endpoint("browser-ticket", {
        ...workspaceRequest,
        workspace: "https://outside.example.test",
      })
    ).status,
  ).toBe(400);
  expect((await endpoint("browser-ticket", { ...workspaceRequest, calendar })).status).toBe(400);
  const workspaceTicket = await endpoint("browser-ticket", workspaceRequest);
  expect(workspaceTicket.status).toBe(200);
  const workspace = await redeemBrowser(
    ((await workspaceTicket.json()) as { ticket: string }).ticket,
  );
  expect(workspace.status).toBe(303);
  expect(workspace.headers.get("location")).toBe("/admin/commerce?view=inventory");
  const sale = await json(
    t.app,
    "/admin/commerce/checkouts",
    "POST",
    {
      lines: [
        { kind: "custom", description: "Synthetic receipt", unitAmountCents: 1200, quantity: 1 },
      ],
      idempotencyKey: crypto.randomUUID(),
    },
    who.cookie,
  );
  expect(sale.status).toBe(201);
  const { id: receiptId } = (await sale.json()) as { id: string };
  const receiptTicketRequest = () => ({
    origin: browserOrigin,
    receipt: receiptId,
    proof: first.proof("browser-ticket", undefined, [browserOrigin, "receipt", receiptId]),
  });
  expect(
    (await endpoint("browser-ticket", { ...receiptTicketRequest(), receipt: crypto.randomUUID() }))
      .status,
  ).toBe(401);
  const missingReceipt = crypto.randomUUID();
  expect(
    (
      await endpoint("browser-ticket", {
        origin: browserOrigin,
        receipt: missingReceipt,
        proof: first.proof("browser-ticket", undefined, [browserOrigin, "receipt", missingReceipt]),
      })
    ).status,
  ).toBe(403);
  const issueReceipt = async () => {
    const response = await endpoint("browser-ticket", receiptTicketRequest());
    expect(response.status).toBe(200);
    return ((await response.json()) as { ticket: string }).ticket;
  };
  const redeemReceipt = await redeemBrowser(await issueReceipt());
  expect(redeemReceipt.status).toBe(303);
  expect(redeemReceipt.headers.get("location")).toBe(`/admin/commerce?checkout=${receiptId}`);
  const observer = await endpoint("token", second.proof("token"));
  expect(observer.status).toBe(200);
  await assertHostedReceiptPayment(
    receiptId,
    cookieFrom(redeemReceipt),
    ((await observer.json()) as { access_token: string }).access_token,
  );
  const operator = await actor(t, "staff", "receipt-workspace-operator@example.test");
  const setReceiptAccess = (accessPreset: "receptionist" | "professional") =>
    t.db.update(staffProfile).set({ accessPreset }).where(eq(staffProfile.userId, operator.userId));
  const requestStaffReceipt = () =>
    t.app.request("/api/auth/desktop/browser-ticket", {
      method: "POST",
      headers: { origin: ORIGIN, cookie: operator.cookie, "content-type": "application/json" },
      body: JSON.stringify({ origin: browserOrigin, receipt: receiptId }),
    });
  await setReceiptAccess("receptionist");
  const staffReceipt = await requestStaffReceipt();
  expect(staffReceipt.status).toBe(200);
  await setReceiptAccess("professional");
  expect((await requestStaffReceipt()).status).toBe(403);
  expect(
    (await redeemBrowser(((await staffReceipt.json()) as { ticket: string }).ticket)).status,
  ).toBe(403);
  const restricted = await actor(t, "staff", "restricted-workspaces@example.test");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.userId, restricted.userId));
  const restrictedHeaders = {
    origin: ORIGIN,
    cookie: restricted.cookie,
    "content-type": "application/json",
  };
  expect(
    await (await t.app.request("/me/desktop-workspaces", { headers: restrictedHeaders })).json(),
  ).toEqual({ workspaces: ["staff"] });
  const deniedWorkspace = await t.app.request("/api/auth/desktop/browser-ticket", {
    method: "POST",
    headers: restrictedHeaders,
    body: JSON.stringify({ origin: browserOrigin, workspace: "settings" }),
  });
  expect(deniedWorkspace.status).toBe(403);
  const revokedTicket = await issueBrowser();
  const payload = first.proof("token");
  const issuance = await endpoint("token", payload);
  expect(issuance.status).toBe(200);
  const firstToken = ((await issuance.json()) as { access_token: string }).access_token;
  expect((await endpoint("token", payload)).status).toBe(401);
  expect((await endpoint("revoke", second.proof("token"))).status).toBe(401);
  expect((await endpoint("token", second.proof("token", 1))).status).toBe(401);
  const menu = await request("/me/desktop-workspaces", firstToken);
  expect(menu.status).toBe(200);
  expect(await menu.json()).toMatchObject({
    workspaces: expect.arrayContaining(["inventory", "settings", "clients"]),
  });
  expect((await request("/sync/pull", firstToken)).status).toBe(200);
  const report = await request(reportPath, firstToken);
  expect(report.status).toBe(200);
  expect(await report.json()).toMatchObject({
    canReportClients: true,
    appointmentBreakdown: { hour: [], service: [], category: [], addon: [] },
  });
  const clients = await request(clientReportPath, firstToken);
  expect(clients.status).toBe(200);
  expect(await clients.json()).toMatchObject({
    rows: [],
    totals: { newClients: 0, returningClients: 0 },
  });
  const sales = await request(salesReportPath, firstToken);
  expect(sales.status).toBe(200);
  expect(sales.headers.get("cache-control")).toBe("private, no-store");
  expect(await sales.json()).toMatchObject({ netCollectedCents: 0, cashSessions: [] });
  expect(
    (
      await t.app.request(salesReportPath, {
        method: "POST",
        headers: { authorization: `Bearer ${firstToken}` },
      })
    ).status,
  ).toBe(403);
  const outcomes = await request(outcomePath, firstToken);
  expect(outcomes.status).toBe(200);
  expect(await outcomes.json()).toMatchObject({ rows: [], page: 1, total: 0 });
  const outcomeCsv = await request(outcomeExportPath, firstToken);
  expect(outcomeCsv.status).toBe(200);
  expect(outcomeCsv.headers.get("content-disposition")).toContain("appointments-no_show");
  expect(await outcomeCsv.text()).toContain('"appointment_id","status"');
  expect((await request("/mcp", firstToken)).status).toBe(401);
  expect((await request("/me/desktop-devices", firstToken)).status).toBe(403);
  expect(await (await list()).json()).toEqual({
    devices: expect.arrayContaining([
      {
        id: first.id,
        label: "Recepción · Linux",
        linkedAt: expect.any(String),
        lastSeenAt: expect.any(String),
      },
      {
        id: second.id,
        label: "Despacho · Mac",
        linkedAt: expect.any(String),
        lastSeenAt: expect.any(String),
      },
    ]),
  });

  const firstUrl = `/me/desktop-devices/${first.id}`;
  const otherHeaders = { cookie: other.cookie, origin: ORIGIN };
  expect(
    await (await t.app.request("/me/desktop-devices", { headers: otherHeaders })).json(),
  ).toEqual({ devices: [] });
  expect((await t.app.request(firstUrl, { method: "DELETE", headers: otherHeaders })).status).toBe(
    204,
  );
  expect((await request("/sync/pull", firstToken)).status).toBe(200);
  const live = await request("/sync/stream", firstToken);
  expect(live.status).toBe(200);
  const reader = live.body!.getReader();
  expect((await reader.read()).done).toBe(false);
  expect((await t.app.request(firstUrl, { method: "DELETE", headers: webHeaders })).status).toBe(
    204,
  );
  expect((await request("/sync/pull", firstToken)).status).toBe(401);
  expect((await request(reportPath, firstToken)).status).toBe(401);
  expect((await request(clientReportPath, firstToken)).status).toBe(401);
  expect((await request(salesReportPath, firstToken)).status).toBe(401);
  expect((await request(outcomeExportPath, firstToken)).status).toBe(401);
  expect((await redeemBrowser(revokedTicket)).status).toBe(403);
  expect((await endpoint("token", first.proof("token"))).status).toBe(404);
  while (!(await reader.read()).done) {
    /* Drain the live connection until revocation closes it. */
  }

  const secondIssued = await endpoint("token", second.proof("token"));
  expect(secondIssued.status).toBe(200);
  const secondToken = ((await secondIssued.json()) as { access_token: string }).access_token;
  expect((await request("/me", secondToken)).status).toBe(200);
  expect((await endpoint("revoke", second.proof("revoke"))).status).toBe(204);
  expect((await endpoint("revoke", second.proof("revoke"))).status).toBe(404);
  expect((await request("/sync/pull", secondToken)).status).toBe(401);
  expect(await (await list()).json()).toEqual({ devices: [] });
});
