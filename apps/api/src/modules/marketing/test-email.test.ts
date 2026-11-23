import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { campaignTestEmailReceiptSchema } from "@sob/contracts";
import { auditLog, marketingCampaign, marketingDelivery, user } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import { actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

const messages: { to: string; content: string }[] = [];
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
    },
  });
});

afterAll(async () => {
  await t.close();
  await new Promise<void>((closed) => smtp.close(() => closed()));
});

async function prepareDraft() {
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
  const id = crypto.randomUUID();
  const root = "/admin/marketing/campaigns";
  const create = await json(
    t.app,
    root,
    "POST",
    {
      id,
      name: "Preview fixture",
      channel: "email",
      subject: "Hello {{first_name}}",
      emailBody: "Welcome to {{salon_name}}. {{booking_url}}",
      smsBody: "",
      audience: {},
      trigger: "manual",
      delayMinutes: 0,
      birthdayLeadDays: 0,
    },
    owner.cookie,
  );
  expect(create.status, await create.clone().text()).toBe(201);
  return { owner, staff, id, root };
}

test("only the verified owner receives a reviewed test, with a safe replay", async () => {
  const { owner, staff, id, root } = await prepareDraft();
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
      campaignTestEmailReceiptSchema.parse(await response.json()).status,
    );
  }
  const retry = await send(owner.cookie);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ status: "accepted", requestId: packet.requestId });
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
  expect(messages[0]?.content).not.toContain("/marketing/opt-out");
  expect(await t.db.select().from(marketingDelivery)).toEqual([]);
});

test("test-email quota counts SMTP claims and permits replays after exhaustion", async () => {
  const { owner, id, root } = await prepareDraft();
  const path = `${root}/${id}/test-email`;
  const send = (version: number, requestId = crypto.randomUUID()) =>
    json(t.app, path, "POST", { version, requestId }, owner.cookie);

  for (let n = 0; n < 3; n++) expect((await send(2)).status).toBe(409);
  const first = crypto.randomUUID();
  for (const response of await Promise.all([send(1, first), send(1, first)]))
    expect(response.status, await response.clone().text()).toBe(200);

  expect((await send(1)).status).toBe(200);
  expect((await send(1)).status).toBe(200);
  expect(messages).toHaveLength(3);

  const limited = await send(1);
  expect(limited.status).toBe(429);
  expect(limited.headers.get("Retry-After")).not.toBeNull();

  const replay = await send(1, first);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual({ status: "accepted", requestId: first });
  expect(messages).toHaveLength(3);
});

test("an SMTP rejection permits a fresh test and an ambiguous send requires another explicit action", async () => {
  const { owner, id, root } = await prepareDraft();
  const send = async (requestId: string, replaceUnconfirmed?: true) => {
    const response = await json(
      t.app,
      `${root}/${id}/test-email`,
      "POST",
      { version: 1, requestId, mode: replaceUnconfirmed ? "replace_unconfirmed" : "send" },
      owner.cookie,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return campaignTestEmailReceiptSchema.parse(await response.json()).status;
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
    return campaignTestEmailReceiptSchema.parse(await response.json());
  };
  const first = crypto.randomUUID();
  const other = crypto.randomUUID();
  const send = next(first, "send");
  try {
    for (let i = 0; i < 100 && !messages.length; i += 1) await Bun.sleep(10);
    expect(messages).toHaveLength(1);
    expect(await next(other, "send")).toEqual({ status: "pending", requestId: first });
  } finally {
    held.resolve();
    await send;
  }
  expect(await next(first, "check")).toEqual({ status: "accepted", requestId: first });
  expect(await next(other, "check")).toEqual({ status: "not_requested", requestId: other });
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
