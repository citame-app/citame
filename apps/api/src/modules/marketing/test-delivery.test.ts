import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import {
  type CampaignEmailLayout,
  campaignPreviewSchema,
  campaignTestReceiptSchema,
  DESKTOP_CLIENT_ID,
  DESKTOP_SIGN_IN_SCOPE,
} from "@sob/contracts";
import { auditLog, marketingCampaign, marketingDelivery, staffProfile, user } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { createAuth } from "../../auth/auth";
import { type AppEnv, loadPrincipal, requireAuth } from "../../auth/principal";
import { DomainError } from "../../errors";
import { respondError } from "../../http";
import type { McpIdentity } from "../../mcp/verify";

const messages: { to: string; content: string }[] = [];
const testPhone = "+15005550006";
const smsMessages: URLSearchParams[] = [];
let smsResult = 201;
let smtpResult: "accept" | "reject" | "disconnect" = "accept";
let smtpAcknowledgement: Promise<void> | null = null;
const smtp = createServer((socket) => {
  let buffer = "";
  let body: string[] | undefined;
  let to = "";
  socket.setEncoding("utf8");
  socket.write("220 localhost test SMTP\r\n");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    let end = buffer.indexOf("\r\n");
    while (end >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      if (body) {
        if (line === ".") {
          if (smtpResult === "reject") {
            body = undefined;
            socket.write("550 rejected by test fixture\r\n");
            end = buffer.indexOf("\r\n");
            continue;
          }
          messages.push({ to, content: body.join("\r\n") });
          body = undefined;
          if (smtpResult === "disconnect") {
            socket.destroy();
            return;
          }
          if (smtpAcknowledgement)
            void smtpAcknowledgement.then(() => socket.write("250 queued by test fixture\r\n"));
          else socket.write("250 queued by test fixture\r\n");
        } else {
          body.push(line);
        }
      } else if (line === "DATA") {
        body = [];
        socket.write("354 send data\r\n");
      } else if (line === "QUIT") {
        socket.end("221 bye\r\n");
      } else {
        if (line.startsWith("RCPT TO:")) to = line.slice("RCPT TO:".length).trim();
        socket.write("250 ok\r\n");
      }
      end = buffer.indexOf("\r\n");
    }
  });
});

let t: Awaited<ReturnType<typeof setupApiTest>>;
beforeAll(async () => {
  await new Promise<void>((ready) => smtp.listen(0, "127.0.0.1", ready));
  const address = smtp.address();
  if (!address || typeof address === "string") throw new Error("No local SMTP listener");
  t = await setupApiTest({
    dbSuffix: "marketing_test_email",
    env: {
      NOTIFY_WORKER_ENABLED: "false",
      NOTIFY_EMAIL_PROVIDER: "smtp",
      SMTP_URL: `smtp://127.0.0.1:${address.port}`,
      NOTIFY_SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC-test-fixture",
      TWILIO_AUTH_TOKEN: "test-fixture",
      TWILIO_FROM: "+15005550007",
      NOTIFY_CAMPAIGN_TEST_SMS_TO: testPhone,
    },
    deps: {
      smsFetch: Object.assign(
        async (_url: string | URL | Request, init?: RequestInit) => {
          if (init?.body instanceof URLSearchParams) smsMessages.push(init.body);
          return Response.json({ sid: "SM-test-fixture" }, { status: smsResult });
        },
        { preconnect: fetch.preconnect },
      ),
    },
  });
});

afterAll(async () => {
  await t.close();
  await new Promise<void>((closed) => smtp.close(() => closed()));
});

async function prepareDraft(emailLayout?: CampaignEmailLayout, channel: "email" | "sms" = "email") {
  await t.reset();
  messages.length = 0;
  smtpResult = "accept";
  smtpAcknowledgement = null;
  const fixtures = await seedFixtures(t.db);
  const [owner, staff] = await Promise.all([
    actor(t, "owner", "preview-owner@example.com"),
    actor(t, "staff", "preview-staff@example.com", {
      staffProfileId: fixtures.anaId,
    }),
  ]);
  return { owner, staff, id: await createDraft(owner.cookie, emailLayout, channel), root };
}

const root = "/admin/marketing/campaigns";

async function createDraft(
  cookie: string,
  emailLayout?: CampaignEmailLayout,
  channel: "email" | "sms" = "email",
) {
  const id = crypto.randomUUID();
  const create = await json(
    t.app,
    root,
    "POST",
    {
      id,
      name: "Preview fixture",
      channel,
      subject: channel === "email" ? "Hello {{first_name}}" : "",
      emailBody: channel === "email" ? "Welcome to {{salon_name}}. {{booking_url}}" : "",
      ...(emailLayout && { emailLayout }),
      smsBody: channel === "sms" ? "Hello {{first_name}} from {{salon_name}}" : "",
      audience: {},
      trigger: "manual",
      delayMinutes: 0,
      birthdayLeadDays: 0,
    },
    cookie,
  );
  expect(create.status, await create.clone().text()).toBe(201);
  return id;
}

test("SMS tests only reach the configured number and do not replay uncertain sends", async () => {
  const { owner, staff, id } = await prepareDraft(undefined, "sms");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.userId, staff.userId));
  smsMessages.length = 0;
  smsResult = 500;
  const path = `${root}/${id}/test-sms`;
  const preview = async (cookie: string) =>
    campaignPreviewSchema.parse(
      await (await json(t.app, `${root}/${id}/preview`, "GET", undefined, cookie)).json(),
    );
  const review = (await preview(owner.cookie)).smsTest;
  if (!review) throw new Error("Expected a reviewed test SMS");
  expect(review).toMatchObject({
    lastFour: "0006",
    message: "Hello {{first_name}} from {{salon_name}}",
  });
  expect(JSON.stringify(review)).not.toContain(testPhone);
  expect((await preview(staff.cookie)).smsTest).toBeUndefined();
  const packet = { version: 1, requestId: crypto.randomUUID(), reviewToken: review.reviewToken };
  const send = (cookie: string, body: unknown = packet, generation = review.generation) =>
    t.app.request(path, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie,
        "content-type": "application/json",
        "x-citame-generation": generation,
      },
      body: JSON.stringify(body),
    });
  expect((await send(staff.cookie)).status).toBe(403);
  expect((await send(owner.cookie, { ...packet, to: "+34600000000" })).status).toBe(400);
  expect((await send(owner.cookie, { ...packet, version: 2 })).status).toBe(409);
  expect((await send(owner.cookie, packet, "old-generation")).status).toBe(409);
  expect((await json(t.app, path, "POST", packet, owner.cookie)).status).toBe(409);
  t.config.notifications.campaignTestSmsTo = "+15005560006";
  try {
    expect((await send(owner.cookie)).status).toBe(409);
  } finally {
    t.config.notifications.campaignTestSmsTo = testPhone;
  }
  expect((await send(owner.cookie, { ...packet, mode: "check" })).status).toBe(200);
  expect(smsMessages).toHaveLength(0);

  const first = await send(owner.cookie);
  expect(await first.json()).toEqual({ status: "unconfirmed", requestId: packet.requestId });
  const replay = await send(owner.cookie, { ...packet, mode: "check" });
  expect(await replay.json()).toEqual({ status: "unconfirmed", requestId: packet.requestId });
  expect(smsMessages).toHaveLength(1);
  expect(smsMessages[0]?.get("To")).toBe(testPhone);
  expect(smsMessages[0]?.get("Body")).toContain(
    "[Prueba / Test] Hello preview-owner from Test Salon",
  );

  smsResult = 201;
  const rotatedPhone = "+15005550009";
  t.config.notifications.campaignTestSmsTo = rotatedPhone;
  try {
    const rotated = (await preview(owner.cookie)).smsTest;
    if (!rotated) throw new Error("Expected the review for the rotated number");
    const requestId = crypto.randomUUID();
    const sent = await send(owner.cookie, {
      ...packet,
      requestId,
      reviewToken: rotated.reviewToken,
    });
    expect(await sent.json()).toEqual({ status: "accepted", requestId });
    expect(smsMessages[1]?.get("To")).toBe(rotatedPhone);
  } finally {
    t.config.notifications.campaignTestSmsTo = testPhone;
  }
  const secondId = crypto.randomUUID();
  const second = await send(owner.cookie, {
    ...packet,
    requestId: secondId,
    mode: "replace_unconfirmed",
    replacesRequestId: packet.requestId,
  });
  expect(await second.json()).toEqual({ status: "accepted", requestId: secondId });
  const staleReplacement = await send(owner.cookie, {
    ...packet,
    requestId: crypto.randomUUID(),
    mode: "replace_unconfirmed",
    replacesRequestId: packet.requestId,
  });
  expect(await staleReplacement.json()).toEqual({ status: "accepted", requestId: secondId });
  expect(smsMessages).toHaveLength(3);
  expect((await send(owner.cookie, { ...packet, requestId: crypto.randomUUID() })).status).toBe(
    429,
  );
  expect(smsMessages).toHaveLength(3);
  const emailDraft = await createDraft(owner.cookie);
  for (let i = 0; i < 3; i++) {
    const email = await json(
      t.app,
      `${root}/${emailDraft}/test-email`,
      "POST",
      { version: 1, requestId: crypto.randomUUID() },
      owner.cookie,
    );
    expect(await email.json()).toMatchObject({ status: "accepted" });
  }
  expect(messages).toHaveLength(3);
  expect(await t.db.select().from(marketingDelivery)).toEqual([]);
});

test("the desktop scope admits the SMS mutation and fences other methods", async () => {
  const { owner, id } = await prepareDraft(undefined, "sms");
  const principal = await loadPrincipal(t.db, owner.userId);
  if (!principal) throw new Error("Expected the test owner");
  const auth = createAuth({ db: t.db, valkey: t.valkey.client, config: t.config });
  const path = `${root}/${id}/test-sms`;
  const verified: McpIdentity = {
    principal,
    clientId: DESKTOP_CLIENT_ID,
    scopes: [DESKTOP_SIGN_IN_SCOPE],
  };
  const app = new Hono<AppEnv>();
  app.onError((error, c) => {
    if (error instanceof DomainError) return respondError(c, error);
    throw error;
  });
  app.use("*", requireAuth(auth, t.db, { verify: async () => verified }));
  app.all(path, (c) => c.json({ desktop: c.get("desktopRequest") }));
  const options = { headers: { authorization: "Bearer synthetic-test-value" } };
  expect(await (await app.request(path, { ...options, method: "POST" })).json()).toEqual({
    desktop: true,
  });
  expect((await app.request(path, options)).status).toBe(403);
  expect((await app.request(path, { ...options, method: "PATCH" })).status).toBe(403);
  verified.scopes.length = 0;
  expect((await app.request(path, { ...options, method: "POST" })).status).toBe(403);
});

test("only the verified owner receives a reviewed test, with a safe replay", async () => {
  const { owner, staff, id, root } = await prepareDraft({
    heading: "Local Campaign Heading",
    preheader: "Preview without customer recipients",
    blocks: [
      { kind: "paragraph", text: "Welcome to {{salon_name}}.", emphasis: "strong" },
      { kind: "booking", label: "Reserve Local Slot" },
    ],
  });
  const path = `${root}/${id}/test-email`;
  const packet = { version: 1, requestId: crypto.randomUUID() };
  const send = (cookie: string, body: unknown = packet) => json(t.app, path, "POST", body, cookie);
  expect((await send(staff.cookie)).status).toBe(403);
  expect((await send(owner.cookie, { ...packet, oversized: "x".repeat(5000) })).status).toBe(413);
  expect((await send(owner.cookie, { ...packet, to: "external@example.com" })).status).toBe(400);
  await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, owner.userId));
  expect((await send(owner.cookie)).status).toBe(403);
  const capabilities = await json(
    t.app,
    "/admin/marketing/capabilities",
    "GET",
    undefined,
    owner.cookie,
  );
  expect(await capabilities.json()).toMatchObject({ canTestEmail: false });
  await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, owner.userId));
  expect((await send(owner.cookie, { ...packet, version: 2 })).status).toBe(409);
  expect(messages).toHaveLength(0);

  for (const response of await Promise.all([send(owner.cookie), send(owner.cookie)])) {
    expect(response.status).toBe(200);
    expect(["accepted", "pending"]).toContain(
      campaignTestReceiptSchema.parse(await response.json()).status,
    );
  }
  const retry = await send(owner.cookie);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({
    status: "accepted",
    requestId: packet.requestId,
  });
  const audit = await t.db
    .select({ action: auditLog.action, metadata: auditLog.metadata })
    .from(auditLog)
    .where(eq(auditLog.entityId, id));
  expect(audit).toContainEqual({
    action: "marketing.campaign_test_accepted",
    metadata: packet,
  });
  expect(messages).toHaveLength(1);
  expect(messages[0]?.to).toBe("<preview-owner@example.com>");
  expect(messages[0]?.content).toContain("Subject: [Prueba / Test] Hello preview-owner");
  const mail = messages[0]?.content.replaceAll("=\r\n", "");
  expect(mail).toContain("Local Campaign Heading");
  expect(mail).toContain("<strong>Welcome to Test Salon.</strong>");
  expect(mail?.match(/Reserve Local Slot/g)).toHaveLength(2);
  expect(messages[0]?.content).not.toContain("/marketing/opt-out");
  expect(await t.db.select().from(marketingDelivery)).toEqual([]);
});

test("test-email quota counts SMTP claims and permits replays after exhaustion", async () => {
  const { owner, id, root } = await prepareDraft();
  const path = `${root}/${id}/test-email`;
  const send = (version: number, requestId = crypto.randomUUID(), target = path) =>
    json(t.app, target, "POST", { version, requestId }, owner.cookie);

  for (let n = 0; n < 3; n++) expect((await send(2)).status).toBe(409);
  const first = crypto.randomUUID();
  for (const response of await Promise.all([send(1, first), send(1, first)]))
    expect(response.status, await response.clone().text()).toBe(200);

  expect((await send(1)).status).toBe(200);
  await t.db.execute(sql`
    create function fail_test_email_claim() returns trigger language plpgsql as $$
    begin
      raise exception 'test fixture rejects the send claim';
    end
    $$
  `);
  try {
    await t.db.execute(sql`
      create trigger fail_test_email_claim before insert on audit_log
      for each row when (new.action = 'marketing.campaign_test_requested')
      execute function fail_test_email_claim()
    `);
    expect((await send(1)).status).toBe(500);
  } finally {
    await t.db.execute(sql`drop function fail_test_email_claim() cascade`);
  }
  expect(messages).toHaveLength(2);

  const secondDraft = `${root}/${await createDraft(owner.cookie)}/test-email`;
  const competing = await Promise.all([send(1), send(1, crypto.randomUUID(), secondDraft)]);
  expect(competing.map(({ status }) => status).sort()).toEqual([200, 429]);
  const limited = competing.find(({ status }) => status === 429);
  expect(limited?.headers.get("Retry-After")).toBe("60");
  expect(messages).toHaveLength(3);

  const replay = await send(1, first);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ status: "accepted", requestId: first });
  expect(messages).toHaveLength(3);

  t.clock.advance(60);
  expect((await send(1, crypto.randomUUID(), secondDraft)).status).toBe(200);
  expect(messages).toHaveLength(4);
});

test("an SMTP rejection permits a fresh test and an ambiguous send requires another explicit action", async () => {
  const { owner, id, root } = await prepareDraft();
  const send = async (requestId: string, replaceUnconfirmed?: true) => {
    const response = await json(
      t.app,
      `${root}/${id}/test-email`,
      "POST",
      {
        version: 1,
        requestId,
        mode: replaceUnconfirmed ? "replace_unconfirmed" : "send",
      },
      owner.cookie,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return campaignTestReceiptSchema.parse(await response.json()).status;
  };
  smtpResult = "reject";
  const rejected = crypto.randomUUID();
  expect(await send(rejected)).toBe("rejected");
  expect(await send(rejected)).toBe("rejected");
  expect(messages).toHaveLength(0);

  smtpResult = "disconnect";
  const interrupted = crypto.randomUUID();
  expect(await send(interrupted)).toBe("unconfirmed");
  expect(messages).toHaveLength(1);

  t.clock.advance(61);
  smtpResult = "accept";
  expect(await send(interrupted)).toBe("unconfirmed");
  expect(await send(crypto.randomUUID())).toBe("unconfirmed");
  expect(messages).toHaveLength(1);
  expect(await send(crypto.randomUUID(), true)).toBe("accepted");
  expect(messages).toHaveLength(2);
});

test("a status check from another window never claims a new send", async () => {
  const { owner, id, root } = await prepareDraft();
  const held = Promise.withResolvers<void>();
  smtpAcknowledgement = held.promise;
  const next = async (requestId: string, mode: "send" | "check") => {
    const response = await json(
      t.app,
      `${root}/${id}/test-email`,
      "POST",
      { version: 1, requestId, mode },
      owner.cookie,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return campaignTestReceiptSchema.parse(await response.json());
  };
  const first = crypto.randomUUID();
  const other = crypto.randomUUID();
  const send = next(first, "send");
  try {
    for (let i = 0; i < 100 && !messages.length; i += 1) await Bun.sleep(10);
    expect(messages).toHaveLength(1);
    expect(await next(other, "send")).toEqual({
      status: "pending",
      requestId: first,
    });
  } finally {
    held.resolve();
    await send;
  }
  expect(await next(first, "check")).toEqual({
    status: "accepted",
    requestId: first,
  });
  expect(await next(other, "check")).toEqual({
    status: "not_requested",
    requestId: other,
  });
  expect(messages).toHaveLength(1);
});

test("a draft edit in flight invalidates the reviewed test before the SMTP claim", async () => {
  const { owner, id, root } = await prepareDraft();
  let request: Promise<Response> | undefined;
  await t.db.transaction(async (tx) => {
    await tx
      .update(marketingCampaign)
      .set({ version: 2, subject: "Edited draft" })
      .where(eq(marketingCampaign.id, id));
    request = Promise.resolve(
      json(
        t.app,
        `${root}/${id}/test-email`,
        "POST",
        { version: 1, requestId: crypto.randomUUID() },
        owner.cookie,
      ),
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [row] = await t.db.execute<{ blocked: boolean }>(sql`
        select exists (
          select from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and query like '%from "marketing_campaign"%for update%'
        ) as blocked
      `);
      if (row?.blocked) return;
      await Bun.sleep(10);
    }
    throw new Error("Expected the reviewed send to wait for the draft edit");
  });
  const response = await request;
  expect(response?.status).toBe(409);
  expect(messages).toHaveLength(0);
});
