import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer } from "node:net";
import { auditLog, marketingDelivery, user } from "@sob/db";
import { eq } from "drizzle-orm";
import { actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";

const messages: { to: string; content: string }[] = [];
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
          messages.push({ to, content: body.join("\r\n") });
          body = undefined;
          socket.write("250 queued by test fixture\r\n");
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

test("only the verified owner receives a reviewed test, with a safe replay", async () => {
  await t.reset();
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
  const path = `${root}/${id}/test-email`;
  const packet = { version: 1, requestId: crypto.randomUUID() };
  const send = (cookie: string, body: unknown = packet) => json(t.app, path, "POST", body, cookie);
  expect((await send(staff.cookie)).status).toBe(403);
  expect((await send(owner.cookie, { ...packet, to: "external@example.com" })).status).toBe(400);
  await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, owner.userId));
  expect((await send(owner.cookie)).status).toBe(403);
  await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, owner.userId));
  expect((await send(owner.cookie, { ...packet, version: 2 })).status).toBe(409);
  expect(messages).toHaveLength(0);

  for (const response of await Promise.all([send(owner.cookie), send(owner.cookie)])) {
    expect([200, 409]).toContain(response.status);
  }
  const retry = await send(owner.cookie);
  expect(retry.status).toBe(200);
  expect(await retry.json()).toEqual({ ok: true });
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
