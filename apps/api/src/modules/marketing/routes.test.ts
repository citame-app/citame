import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  type Campaign,
  campaignPreviewSchema,
  campaignSchema,
  marketingConsentSchema,
  syncPullResponseSchema,
} from "@sob/contracts";
import { appointment, clientProfile, marketingCampaign, marketingDelivery } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { FakeEmailProvider, FakeSmsProvider } from "../../notifications/providers/fake";
import { PermanentProviderError } from "../../notifications/providers/types";
import { signMarketingOptOut } from "./tokens";
import { createMarketingWorker } from "./worker";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor, staff: Actor, client: Actor;
let clock = new Date("2026-11-17T09:00:00Z");
let email: FakeEmailProvider, sms: FakeSmsProvider;
const call = (who: Actor | null, path: string, method = "GET", body?: unknown) =>
  json(t.app, path, method, body, who?.cookie);
const draft = (extra: Record<string, unknown> = {}) => ({
  id: crypto.randomUUID(),
  name: "Salon's news",
  channel: "email",
  subject: "Hello {{first_name}}",
  emailBody: "Hello {{first_name}}. New services at {{salon_name}}. Book: {{booking_url}}",
  smsBody: "New services: {{booking_url}}",
  audience: { tags: [], inactiveDays: null, noFutureAppointments: false },
  trigger: "manual",
  delayMinutes: 120,
  birthdayLeadDays: 0,
  ...extra,
});
async function create(extra: Record<string, unknown> = {}) {
  const response = await call(owner, "/admin/marketing/campaigns", "POST", draft(extra));
  expect(response.status, await response.clone().text()).toBe(201);
  return campaignSchema.parse(await response.json());
}
async function allow(channel: "email" | "sms" = "email", enabled = true, version = 0) {
  const response = await call(
    owner,
    `/admin/clients/${client.clientId}/marketing-consent`,
    "PATCH",
    { channel, enabled, version, source: "Explicit salon consent fixture" },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return marketingConsentSchema.parse(await response.json());
}
async function preview(campaign: Campaign) {
  const response = await call(owner, `/admin/marketing/campaigns/${campaign.id}/preview`);
  expect(response.status, await response.clone().text()).toBe(200);
  return campaignPreviewSchema.parse(await response.json());
}
async function queue(campaign: Campaign, scheduledFor: string | null = null) {
  const audience = await preview(campaign);
  const packet = { version: campaign.version, audienceHash: audience.audienceHash, scheduledFor };
  const response = await call(
    owner,
    `/admin/marketing/campaigns/${campaign.id}/queue`,
    "POST",
    packet,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return { campaign: campaignSchema.parse(await response.json()), packet };
}
const worker = (id: string = crypto.randomUUID()) =>
  createMarketingWorker({
    db: t.db,
    config: t.config.notifications,
    providers: { email, sms },
    now: () => clock,
    workerId: id,
  });
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "marketing",
    env: {
      NOTIFY_WORKER_ENABLED: "false",
      NOTIFY_EXTERNAL_WORKER_ENABLED: "true",
      NOTIFY_EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtp://127.0.0.1:1",
      NOTIFY_SMS_PROVIDER: "twilio",
      TWILIO_ACCOUNT_SID: "AC-public-test-fixture",
      TWILIO_AUTH_TOKEN: "public-test-fixture",
      TWILIO_FROM: "+15005550006",
    },
    deps: { now: () => clock },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, staff, client] = await Promise.all([
    actor(t, "owner", "marketing-owner@example.com"),
    actor(t, "staff", "marketing-staff@example.com", { staffProfileId: f.anaId }),
    actor(t, "client", "marketing-client@example.com"),
  ]);
  clock = new Date("2026-11-17T09:00:00Z");
  email = new FakeEmailProvider();
  sms = new FakeSmsProvider();
  await t.db
    .update(clientProfile)
    .set({ phone: "+15005550006" })
    .where(eq(clientProfile.id, client.clientId!));
});

test("campaigns require marketing access; commercial consent defaults to off independently of booking reminders", async () => {
  expect((await call(client, "/admin/marketing/campaigns")).status).toBe(403);
  expect((await call(staff, "/admin/marketing/campaigns")).status).toBe(403);
  const preferences = marketingConsentSchema.parse(
    await (await call(client, "/me/marketing-consent")).json(),
  );
  expect(preferences).toMatchObject({
    email: { enabled: false, version: 0 },
    sms: { enabled: false, version: 0 },
  });
  expect(
    (
      await call(staff, `/admin/clients/${client.clientId}/marketing-consent`, "PATCH", {
        channel: "email",
        enabled: true,
        version: 0,
        source: "Not authorized",
      })
    ).status,
  ).toBe(403);
  const campaign = await create();
  expect((await preview(campaign)).eligible).toBe(0);
  const granted = await allow();
  expect(granted.email).toMatchObject({ enabled: true, version: 1 });
  const replayed = await allow("email", true, 0);
  expect(replayed.email).toMatchObject({ enabled: true, version: 1 });
  expect((await preview(campaign)).eligible).toBe(1);
  expect(
    (
      await call(owner, `/admin/clients/${client.clientId}/marketing-consent`, "PATCH", {
        channel: "email",
        enabled: false,
        version: 0,
        source: "Stale review",
      })
    ).status,
  ).toBe(409);
});

test("draft replay, optimistic editing, reviewed audience and queue replay are fenced", async () => {
  await allow();
  const input = draft();
  const response = await call(owner, "/admin/marketing/campaigns", "POST", input);
  const first = campaignSchema.parse(await response.json());
  expect((await call(owner, "/admin/marketing/campaigns", "POST", input)).status).toBe(201);
  expect(
    (await call(owner, "/admin/marketing/campaigns", "POST", { ...input, name: "Changed replay" }))
      .status,
  ).toBe(409);
  const changed = await call(owner, `/admin/marketing/campaigns/${first.id}`, "PATCH", {
    ...draft(),
    id: undefined,
    version: first.version,
    name: "Revised draft",
  });
  expect(changed.status).toBe(200);
  const current = campaignSchema.parse(await changed.json());
  expect(
    (
      await call(owner, `/admin/marketing/campaigns/${first.id}`, "PATCH", {
        ...input,
        id: undefined,
        version: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await call(owner, `/admin/marketing/campaigns/${first.id}/queue`, "POST", {
        version: current.version,
        audienceHash: "0".repeat(64),
        scheduledFor: null,
      })
    ).status,
  ).toBe(409);
  const queued = await queue(current);
  expect(
    (await call(owner, `/admin/marketing/campaigns/${first.id}/queue`, "POST", queued.packet))
      .status,
  ).toBe(200);
  expect(
    (
      await call(owner, `/admin/marketing/campaigns/${first.id}/queue`, "POST", {
        ...queued.packet,
        scheduledFor: "2026-12-01T12:00:00Z",
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(marketingDelivery)).toHaveLength(1);
});

test("marketing refresh is scoped and restored desktop generations cannot queue", async () => {
  await allow();
  const previous = syncPullResponseSchema.parse(
    await (await call(owner, "/sync/pull?since=0")).json(),
  );
  const campaign = await create({ name: "Synthetic private campaign" });
  const audience = await preview(campaign);
  const since = `/sync/pull?since=${previous.headSeq}`;
  const legacy = syncPullResponseSchema.parse(await (await call(owner, since)).json());
  expect(legacy.refresh ?? []).not.toContain("marketing");
  const enabled = `${since}&marketingViews=1`;
  const ownerPull = syncPullResponseSchema.parse(await (await call(owner, enabled)).json());
  const staffPull = syncPullResponseSchema.parse(await (await call(staff, enabled)).json());
  expect(ownerPull.refresh).toContain("marketing");
  expect(staffPull.refresh ?? []).not.toContain("marketing");
  expect(JSON.stringify(ownerPull)).not.toContain(campaign.name);
  await t.db
    .update(marketingCampaign)
    .set({ evaluatedAt: clock })
    .where(eq(marketingCampaign.id, campaign.id));
  const quiet = syncPullResponseSchema.parse(
    await (await call(owner, `/sync/pull?since=${ownerPull.headSeq}&marketingViews=1`)).json(),
  );
  expect(quiet.refresh ?? []).not.toContain("marketing");
  const confirm = (generation: string) =>
    t.app.request(`/admin/marketing/campaigns/${campaign.id}/queue`, {
      method: "POST",
      headers: {
        origin: "http://localhost:3000",
        cookie: owner.cookie,
        "content-type": "application/json",
        "x-citame-generation": generation,
      },
      body: JSON.stringify({
        version: campaign.version,
        audienceHash: audience.audienceHash,
        scheduledFor: "2026-11-18T12:00:00.000Z",
      }),
    });
  const stale = await confirm("old-history");
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  expect(await t.db.select().from(marketingDelivery)).toHaveLength(0);
  const safe = await confirm(t.config.syncReplicaGeneration);
  expect(safe.status, await safe.clone().text()).toBe(200);
  expect(await safe.json()).toMatchObject({ status: "scheduled" });
});

test("scheduled delivery uses fake providers once across concurrent workers and includes a separate safe unsubscribe link", async () => {
  await allow();
  await t.db
    .update(clientProfile)
    .set({ name: "<script>customer</script>" })
    .where(eq(clientProfile.id, client.clientId!));
  const campaign = await create();
  await queue(campaign, "2026-11-17T10:00:00Z");
  expect(await worker().runOnce()).toBe(0);
  expect(email.calls).toHaveLength(0);
  clock = new Date("2026-11-17T10:00:00Z");
  await Promise.all([worker("one").runOnce(), worker("two").runOnce()]);
  expect(email.calls).toHaveLength(1);
  expect(sms.calls).toHaveLength(0);
  const message = email.calls[0]!;
  expect(message.html).toContain("&lt;script&gt;");
  expect(message.html).not.toContain("<script>");
  expect(message.text).toContain("/marketing/opt-out?token=m1.");
  const sent = campaignSchema.parse(
    await (await call(owner, `/admin/marketing/campaigns/${campaign.id}`)).json(),
  );
  expect(sent).toMatchObject({ status: "completed", counts: { sent: 1, pending: 0 } });
  await worker().runOnce();
  expect(email.calls).toHaveLength(1);
});

test("shutdown releases unstarted campaign sends and respects a concurrent cancellation", async () => {
  await allow();
  const campaigns = await Promise.all([create(), create(), create()]);
  const queued = await Promise.all(campaigns.map((campaign) => queue(campaign)));
  const entered = Promise.withResolvers<void>();
  const send = Promise.withResolvers<void>();
  email.beforeDeliver = async () => {
    entered.resolve();
    await send.promise;
  };
  const current = worker("draining");
  current.start();
  await entered.promise;
  let cancelledId: string;
  const stopping = current.stop();
  try {
    const deliveries = await t.db.select().from(marketingDelivery);
    const waiting = deliveries.filter((row) => row.id !== email.calls[0]?.idempotencyKey);
    expect(waiting).toHaveLength(2);
    const cancel = queued.find(({ campaign }) => campaign.id === waiting[0]?.campaignId)!;
    cancelledId = cancel.campaign.id;
    const response = await call(owner, `/admin/marketing/campaigns/${cancelledId}/cancel`, "POST", {
      version: cancel.campaign.version,
    });
    expect(response.status).toBe(200);
  } finally {
    send.resolve();
    await stopping;
  }
  const deliveries = await t.db.select().from(marketingDelivery);
  expect(deliveries.find((row) => row.campaignId === cancelledId)).toMatchObject({
    status: "cancelled",
    reason: "campaign_cancelled",
    lockedBy: null,
    lockedUntil: null,
  });
  expect(deliveries.find((row) => row.status === "pending")).toMatchObject({
    reason: null,
    lockedBy: null,
    lockedUntil: null,
  });
  expect(email.calls).toHaveLength(1);
  expect(await worker("replacement").runOnce()).toBe(1);
  expect(email.calls).toHaveLength(2);
});

test("a declined consent or a new future booking is rechecked before delivery", async () => {
  await allow();
  const first = await create();
  await queue(first);
  await allow("email", false, 1);
  await worker().runOnce();
  expect(email.calls).toHaveLength(0);
  await allow("email", true, 2);
  const second = await create({
    audience: { tags: [], inactiveDays: null, noFutureAppointments: true },
  });
  await queue(second);
  await t.db.insert(appointment).values({
    staffId: f.anaId,
    clientId: client.clientId!,
    startsAt: new Date("2026-11-18T12:00:00Z"),
    endsAt: new Date("2026-11-18T13:00:00Z"),
  });
  await worker().runOnce();
  expect(email.calls).toHaveLength(0);
  expect((await t.db.select().from(marketingDelivery)).map((row) => row.reason).sort()).toEqual([
    "client_has_future_booking",
    "marketing_permission_withdrawn",
  ]);
});

test("optimized delivery falls back to consented SMS without sending both channels", async () => {
  await allow("sms");
  const campaign = await create({ channel: "optimized" });
  expect(await preview(campaign)).toMatchObject({ eligible: 1, email: 0, sms: 1 });
  await queue(campaign);
  await worker().runOnce();
  expect(sms.calls).toHaveLength(1);
  expect(email.calls).toHaveLength(0);
});

test("public preview is read-only and signed opt-out only disables the commercial channel", async () => {
  await allow();
  const token = signMarketingOptOut(t.config.notifications.signingSecret, {
    clientId: client.clientId!,
    channel: "email",
  });
  expect((await call(null, `/marketing/opt-out?token=${token}`)).status).toBe(200);
  expect(
    marketingConsentSchema.parse(await (await call(client, "/me/marketing-consent")).json()).email
      .enabled,
  ).toBe(true);
  expect((await call(null, `/marketing/opt-out?token=${token.slice(0, -1)}x`)).status).toBe(400);
  const opted = await t.app.request(`/marketing/opt-out?token=${token}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
  });
  expect(opted.status, await opted.clone().text()).toBe(200);
  expect(
    marketingConsentSchema.parse(await (await call(client, "/me/marketing-consent")).json()).email
      .enabled,
  ).toBe(false);
  const transactional = await call(client, "/me/notification-preferences");
  expect(transactional.status).toBe(200);
  expect(await transactional.json()).toMatchObject({
    email: { transactional: true, reminder: true },
  });
});

test("first-visit and birthday automations issue one delivery per occurrence", async () => {
  await allow();
  const first = await create({ trigger: "first_visit" });
  await queue(first);
  await t.db.insert(appointment).values({
    staffId: f.anaId,
    clientId: client.clientId!,
    startsAt: new Date("2026-11-17T10:00:00Z"),
    endsAt: new Date("2026-11-17T11:00:00Z"),
    status: "completed",
  });
  clock = new Date("2026-11-17T12:00:00Z");
  await worker().runOnce();
  expect(email.calls).toHaveLength(0);
  clock = new Date("2026-11-17T13:00:00Z");
  await worker().runOnce();
  expect(email.calls).toHaveLength(1);
  await worker().runOnce();
  expect(email.calls).toHaveLength(1);
  await t.db
    .update(clientProfile)
    .set({ contactDetails: { birthday: { month: 11, day: 17 } } })
    .where(eq(clientProfile.id, client.clientId!));
  const birthday = await create({ trigger: "birthday" });
  expect(
    (
      await t.db.execute<{ kind: string }>(
        sql`select jsonb_typeof(contact_details) as kind from client_profile where id=${client.clientId}::uuid`,
      )
    )[0]?.kind,
  ).toBe("object");
  expect(await preview(birthday)).toMatchObject({ eligible: 1 });
  await queue(birthday);
  await worker().runOnce();
  expect(email.calls).toHaveLength(2);
  clock = new Date("2027-11-17T13:00:00Z");
  await worker().runOnce();
  expect(email.calls).toHaveLength(3);
});

test("uncertain provider results and expired sends are not automatically sent again; cancellation withdraws pending work", async () => {
  await allow();
  const uncertain = await create();
  await queue(uncertain);
  email.failNext(1);
  await worker().runOnce();
  await worker().runOnce();
  expect(email.calls).toHaveLength(1);
  const [result] = await t.db
    .select()
    .from(marketingDelivery)
    .where(eq(marketingDelivery.campaignId, uncertain.id));
  expect(result?.status).toBe("unknown");
  const rejected = await create();
  await queue(rejected);
  email.failNext(1, new PermanentProviderError("fixture rejection"));
  await worker().runOnce();
  expect(
    (
      await t.db
        .select()
        .from(marketingDelivery)
        .where(eq(marketingDelivery.campaignId, rejected.id))
    )[0]?.status,
  ).toBe("failed");
  const cancelled = await create();
  const queued = await queue(cancelled);
  expect(
    (
      await call(owner, `/admin/marketing/campaigns/${cancelled.id}/cancel`, "POST", {
        version: queued.campaign.version,
      })
    ).status,
  ).toBe(200);
  await worker().runOnce();
  expect(email.calls).toHaveLength(2);
  const dead = await create();
  await queue(dead);
  await t.db
    .update(marketingDelivery)
    .set({
      status: "processing",
      lockedBy: "crashed",
      lockedUntil: new Date(clock.getTime() - 1000),
    })
    .where(eq(marketingDelivery.campaignId, dead.id));
  await worker().runOnce();
  expect(email.calls).toHaveLength(2);
  expect(
    (
      await t.db.select().from(marketingDelivery).where(eq(marketingDelivery.campaignId, dead.id))
    )[0]?.status,
  ).toBe("unknown");
});

test("tagged audiences are bound to the reviewed consent set", async () => {
  await allow();
  await t.db
    .update(clientProfile)
    .set({ tags: ["vip"] })
    .where(eq(clientProfile.id, client.clientId!));
  const campaign = await create({
    audience: { tags: ["VIP"], inactiveDays: null, noFutureAppointments: false },
  });
  const reviewed = await preview(campaign);
  expect(reviewed.eligible).toBe(1);
  await allow("email", false, 1);
  expect(
    (
      await call(owner, `/admin/marketing/campaigns/${campaign.id}/queue`, "POST", {
        version: campaign.version,
        audienceHash: reviewed.audienceHash,
        scheduledFor: null,
      })
    ).status,
  ).toBe(409);
});
