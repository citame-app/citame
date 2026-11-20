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
  intakeFormsSchema,
  reviewPrivateSchema,
  startedPaymentSchema,
  syncPullResponseSchema,
} from "@sob/contracts";
import { appointment, checkoutPayment, staffProfile } from "@sob/db";
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
  expect(await summary.json()).toEqual({
    forms: [{ id: draft.id, title: definition.title, active: false, publishedNumber: null }],
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
