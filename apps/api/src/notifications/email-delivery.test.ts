import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { emailDeliverySettingsSchema } from "@sob/contracts";
import { auditLog, clientProfile, emailDelivery, reminder } from "@sob/db";
import { eq } from "drizzle-orm";
import { actor, json, MONDAY_0900, NOW, seedFixtures, setupApiTest } from "../../test/helpers";
import { createAppointment } from "../modules/appointments/service";
import { resolvePublicSmtp } from "./providers/public-smtp";
import { PermanentProviderError } from "./providers/types";
import { createNotificationWorker } from "./worker";

const sentId = "ebb2189f-8fe4-45a4-af8b-f16ed463352c";
const secret = "re_synthetic-only";
const settings = { provider: "resend", fromEmail: "bookings@example.com", fromName: "Citame Test" };
const outbound: Request[] = [];
let providerStatus = 200;
const emailFetch = (async (url: string, init?: RequestInit) => {
  outbound.push(new Request(url, init));
  return Response.json(
    providerStatus === 200 ? { id: sentId } : { name: "private provider error" },
    { status: providerStatus },
  );
}) as typeof fetch;
let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Awaited<ReturnType<typeof seedFixtures>>;
let owner: Awaited<ReturnType<typeof actor>>;
const path = "/admin/email-delivery";

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "email_delivery", deps: { emailFetch } });
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
  outbound.length = 0;
  providerStatus = 200;
});
afterAll(async () => await t.close());

async function save() {
  const response = await json(
    t.app,
    path,
    "PUT",
    { revision: null, settings, secret },
    owner.cookie,
  );
  expect(response.status).toBe(200);
  return emailDeliverySettingsSchema.parse(await response.json());
}

test("only owners configure delivery, credentials stay encrypted, and stale writes fail", async () => {
  const staff = await actor(t, "staff", "pro@example.com", { staffProfileId: f.anaId });
  expect((await json(t.app, path, "GET")).status).toBe(401);
  expect((await json(t.app, path, "GET", undefined, staff.cookie)).status).toBe(403);
  expect(
    (await json(t.app, path, "PUT", { revision: null, settings, secret }, staff.cookie)).status,
  ).toBe(403);
  const initial = await json(t.app, path, "GET", undefined, owner.cookie);
  expect(initial.headers.get("cache-control")).toBe("private, no-store");
  expect(await initial.json()).toMatchObject({ revision: null, settings: { provider: "inherit" } });
  const result = await save();
  expect(result).toMatchObject({ settings, hasSecret: true });
  const [stored] = await t.db.select().from(emailDelivery);
  expect(stored?.encryptedSecret).toBeString();
  expect(JSON.stringify(stored)).not.toContain(secret);
  expect(await (await json(t.app, path, "GET", undefined, owner.cookie)).text()).not.toContain(
    secret,
  );
  expect(JSON.stringify(await t.db.select().from(auditLog))).not.toContain(secret);
  const renamed = await json(
    t.app,
    path,
    "PUT",
    {
      revision: result.revision,
      settings: { ...settings, fromName: "New sender" },
    },
    owner.cookie,
  );
  expect(renamed.status).toBe(200);
  expect((await t.db.select().from(emailDelivery))[0]?.encryptedSecret).toBe(
    stored?.encryptedSecret,
  );
  const stale = await json(
    t.app,
    path,
    "PUT",
    {
      revision: result.revision,
      settings: { provider: "disabled" },
    },
    owner.cookie,
  );
  expect(stale.status).toBe(409);
  expect(outbound).toHaveLength(0);
});

test("test sends only to the owner, rate limits requests and hides provider errors", async () => {
  const staff = await actor(t, "staff", "pro@example.com", { staffProfileId: f.anaId });
  await save();
  const probe = (cookie = owner.cookie) =>
    json(t.app, `${path}/test`, "POST", { to: "client@example.com" }, cookie);
  expect((await probe(staff.cookie)).status).toBe(403);
  expect((await probe()).status).toBe(200);
  expect(outbound).toHaveLength(1);
  const [call] = outbound;
  expect(call?.url).toBe("https://api.resend.com/emails");
  expect(call?.headers.get("authorization")).toBe(`Bearer ${secret}`);
  expect(await call?.json()).toMatchObject({ to: ["owner@example.com"] });
  providerStatus = 401;
  const refused = await probe();
  expect(refused.status).toBe(409);
  expect(await refused.text()).not.toContain("private provider error");
  expect((await probe()).status).toBe(409);
  expect((await probe()).status).toBe(429);
});

test("the running worker picks up saved changes and preserves retry keys, attachments and opt-out", async () => {
  await t.db
    .update(clientProfile)
    .set({ email: "client@example.com" })
    .where(eq(clientProfile.id, f.clientId));
  await createAppointment(
    t.db,
    { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900, clientId: f.clientId },
    { userId: owner.userId },
    { now: NOW },
  );
  let clock = NOW;
  const worker = createNotificationWorker({
    db: t.db,
    config: t.config.notifications,
    providers: { email: null, sms: null },
    emailFetch,
    now: () => clock,
    log: () => {},
  });
  const saved = await save();
  providerStatus = 429;
  await worker.runOnce();
  const [job] = await t.db.select().from(reminder).where(eq(reminder.kind, "confirmation"));
  expect(job?.status).toBe("pending");
  expect(job?.lastError).toBe("resend_temporary_429");
  expect(outbound[0]?.headers.get("idempotency-key")).toBe(job?.id ?? null);
  providerStatus = 200;
  clock = new Date("2026-03-02T13:00:00Z");
  await worker.runOnce();
  expect(outbound[1]?.headers.get("idempotency-key")).toBe(job?.id ?? null);
  const confirmation = await outbound[1]?.json();
  expect(confirmation).toMatchObject({
    to: ["client@example.com"],
    attachments: [{ filename: "invite.ics" }],
  });
  const [completed] = await t.db.select().from(reminder).where(eq(reminder.kind, "confirmation"));
  expect(completed?.providerMessageId).toBe(sentId);
  clock = new Date("2026-03-08T12:00:00Z");
  await worker.runOnce();
  expect(await outbound[2]?.json()).toMatchObject({
    headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  });
  const disabled = await json(
    t.app,
    path,
    "PUT",
    {
      revision: saved.revision,
      settings: { provider: "disabled" },
    },
    owner.cookie,
  );
  expect(disabled.status).toBe(200);
  clock = new Date("2026-03-09T10:00:00Z");
  await worker.runOnce();
  expect(outbound).toHaveLength(3);
  expect((await t.db.select().from(emailDelivery))[0]?.encryptedSecret).toBeNull();
});

test("SMTP rejects private, loopback and mixed DNS results", async () => {
  for (const address of [
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "100.64.1.1",
    "172.17.0.1",
    "192.168.1.1",
    "192.0.2.1",
    "224.0.0.1",
  ]) {
    await expect(
      resolvePublicSmtp("smtp.example.com", async () => ["8.8.8.8", address]),
    ).rejects.toBeInstanceOf(PermanentProviderError);
  }
  expect(await resolvePublicSmtp("smtp.example.com", async () => ["8.8.8.8"])).toBe("8.8.8.8");
  await expect(resolvePublicSmtp("127.0.0.1")).rejects.toBeInstanceOf(PermanentProviderError);
});
