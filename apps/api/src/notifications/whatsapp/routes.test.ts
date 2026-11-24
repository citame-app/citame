import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { syncPullResponseSchema, whatsappDeskSchema, whatsappSettingsSchema } from "@sob/contracts";
import { appointment, clientProfile, reminder, whatsappConnection } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

const secret = "meta-secret-for-synthetic-webhook";
const verifyToken = "validation-for-synthetic-webhook";
const calls: string[] = [];
const originalSender = { wabaId: "456789", phoneId: "345678" };
let graphPhoneId = originalSender.phoneId;
let graphCoexistence = true;
let cloudRegistered = false;
let subscriptionFails = false;
let registrations: unknown[] = [];
let pauseExchange: (() => Promise<Response | undefined>) | undefined;
let onTemplates: (() => void) | undefined;
const graph = (async (url: URL, options?: RequestInit) => {
  calls.push(url.pathname);
  if (url.pathname.endsWith("/oauth/access_token")) {
    return (await pauseExchange?.()) ?? Response.json({ access_token: "synthetic-credential" });
  }
  if (url.pathname.endsWith("/phone_numbers"))
    return Response.json({
      data: [
        {
          id: graphPhoneId,
          display_phone_number: "+34 611 000 000",
          is_on_biz_app: graphCoexistence,
          status: cloudRegistered ? "CONNECTED" : undefined,
          platform_type: "CLOUD_API",
        },
      ],
    });
  if (url.pathname.endsWith("/register")) {
    registrations.push(JSON.parse(String(options?.body)));
    cloudRegistered = true;
    return Response.json({ success: true });
  }
  if (url.pathname.endsWith("/subscribed_apps"))
    return subscriptionFails
      ? new Response(null, { status: 503 })
      : Response.json({ success: true });
  if (url.pathname.endsWith("/message_templates")) {
    onTemplates?.();
    return Response.json({
      data: [
        {
          id: "678901",
          name: "recordatorio",
          language: "es_ES",
          status: "APPROVED",
          category: "UTILITY",
          components: [{ type: "BODY", text: "Tu cita es a las {{1}}." }],
        },
      ],
    });
  }
  return new Response(null, { status: 500 });
}) as typeof fetch;

let t: Awaited<ReturnType<typeof setupApiTest>>;
let owner: Actor;
let f: Awaited<ReturnType<typeof seedFixtures>>;
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "whatsapp_routes",
    env: {
      META_WHATSAPP_APP_ID: "123456",
      META_WHATSAPP_CONFIG_ID: "234567",
      META_WHATSAPP_APP_SECRET: secret,
      META_WHATSAPP_VERIFY_TOKEN: verifyToken,
      NOTIFY_PUBLIC_URL: "https://salon.test",
    },
    deps: { whatsappFetch: graph },
  });
});
beforeEach(async () => {
  await t.reset();
  calls.length = 0;
  graphPhoneId = originalSender.phoneId;
  graphCoexistence = true;
  cloudRegistered = false;
  subscriptionFails = false;
  registrations = [];
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
});
afterAll(async () => await t.close());

function connect(phoneId = originalSender.phoneId, wabaId = originalSender.wabaId) {
  return json(
    t.app,
    "/admin/whatsapp/connect",
    "POST",
    {
      code: "synthetic-login-code",
      wabaId,
      phoneId,
    },
    owner.cookie,
  );
}

test("validates the OAuth asset, skips registration for coexistence, encrypts the credential and protects settings", async () => {
  const staff = await actor(t, "staff", "staff@example.com", { staffProfileId: f.anaId });
  expect((await json(t.app, "/admin/whatsapp", "GET", undefined, staff.cookie)).status).toBe(403);
  expect((await connect("999999")).status).toBe(400);
  expect(await t.db.select().from(whatsappConnection)).toEqual([]);
  const res = await connect();
  expect(res.status).toBe(200);
  const body = whatsappSettingsSchema.parse(await res.json());
  expect(body.connection).toMatchObject({ phone: "+34 611 000 000", coexistence: true, rules: [] });
  expect(JSON.stringify(body)).not.toContain("synthetic-credential");
  expect(calls.some((path) => path.endsWith("/register"))).toBe(false);
  expect(calls).toContain("/v27.0/456789/subscribed_apps");
  const [record] = await t.db.select().from(whatsappConnection);
  expect(record?.encryptedToken).not.toContain("synthetic-credential");
});

test("a new Cloud API number requires a PIN and can finish after a failed webhook subscription", async () => {
  graphCoexistence = false;
  subscriptionFails = true;
  const settings = await json(t.app, "/admin/whatsapp", "GET", undefined, owner.cookie);
  const { signupRevision } = whatsappSettingsSchema.parse(await settings.json());
  const enroll = (code: string, pin?: string) =>
    json(
      t.app,
      "/admin/whatsapp/connect/reviewed",
      "POST",
      { code, ...originalSender, revision: signupRevision, ...(pin ? { pin } : {}) },
      owner.cookie,
    );

  expect((await enroll("synthetic-missing-pin")).status).toBe(400);
  expect(registrations).toEqual([]);
  expect(calls).not.toContain("/v27.0/456789/subscribed_apps");
  const failed = await enroll("synthetic-first-attempt", "123456");
  expect(failed.ok).toBe(false);
  expect(await failed.json()).toMatchObject({ error: { code: "invalid_state" } });
  expect(registrations).toEqual([{ messaging_product: "whatsapp", pin: "123456" }]);
  expect(await t.db.select().from(whatsappConnection)).toEqual([]);

  subscriptionFails = false;
  const recovered = await enroll("synthetic-new-code");
  expect(recovered.status).toBe(200);
  expect(whatsappSettingsSchema.parse(await recovered.json()).connection).toMatchObject({
    phone: "+34 611 000 000",
    coexistence: false,
  });
  expect(registrations).toHaveLength(1);
  expect(calls.filter((path) => path.endsWith("/subscribed_apps"))).toHaveLength(2);
});

test("schedules an existing appointment when a rule is enabled and records signed delivery updates", async () => {
  expect((await connect()).status).toBe(200);
  await t.db
    .update(clientProfile)
    .set({ phone: "+34600000001" })
    .where(eq(clientProfile.id, f.clientId));
  const created = await json(
    t.app,
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    },
    owner.cookie,
  );
  expect(created.status).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const saved = await json(
    t.app,
    "/admin/whatsapp/rules",
    "PATCH",
    [
      {
        kind: "reminder_24h",
        templateId: "678901",
        variables: ["time"],
      },
    ],
    owner.cookie,
  );
  expect(saved.status).toBe(200);
  const jobs = await t.db.select().from(reminder).where(eq(reminder.channel, "whatsapp"));
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ appointmentId: id, kind: "reminder_24h", status: "pending" });
  const jobId = jobs[0]!.id;
  const deskPath = "/admin/whatsapp/desk";
  const staff = await actor(t, "staff", "staff@example.com", { staffProfileId: f.anaId });
  expect((await json(t.app, deskPath, "GET")).status).toBe(401);
  expect((await json(t.app, deskPath, "GET", undefined, staff.cookie)).status).toBe(403);
  const desk = await json(t.app, deskPath, "GET", undefined, owner.cookie);
  expect(desk.headers.get("cache-control")).toBe("private, no-store");
  const body = await desk.text();
  expect(body).not.toContain("synthetic-credential");
  expect(body).not.toContain("lastError");
  expect(body).not.toContain(id);
  expect(whatsappDeskSchema.parse(JSON.parse(body))).toMatchObject({
    configured: true,
    connection: {
      phone: "+34 611 000 000",
      coexistence: true,
      rules: [
        {
          kind: "reminder_24h",
          templateName: "recordatorio",
          language: "es_ES",
          variables: ["time"],
        },
      ],
    },
    deliveries: [{ id: jobId, kind: "reminder_24h", status: "pending", uncertain: false }],
  });

  const head = await json(t.app, "/sync/pull", "GET", undefined, owner.cookie);
  const { headSeq } = syncPullResponseSchema.parse(await head.json());
  await t.db
    .update(reminder)
    .set({ lastError: "whatsapp_delivery_unknown" })
    .where(eq(reminder.id, jobId));
  for (const [cookie, optIn, visible] of [
    [owner.cookie, true, true],
    [owner.cookie, false, false],
    [staff.cookie, true, false],
  ] as const) {
    const pull = await json(
      t.app,
      `/sync/pull?since=${headSeq}${optIn ? "&whatsappDesk=1" : ""}`,
      "GET",
      undefined,
      cookie,
    );
    const reply = syncPullResponseSchema.parse(await pull.json());
    expect(reply.refresh?.includes("whatsapp_desk") ?? false).toBe(visible);
    expect(reply.changes).toEqual([]);
  }
  const changed = await json(t.app, deskPath, "GET", undefined, owner.cookie);
  expect(whatsappDeskSchema.parse(await changed.json()).deliveries[0]?.uncertain).toBe(true);

  const disabled = await json(t.app, "/admin/whatsapp/rules", "PATCH", [], owner.cookie);
  expect(disabled.status).toBe(200);
  expect((await t.db.select().from(reminder).where(eq(reminder.id, jobId)))[0]?.status).toBe(
    "cancelled",
  );
  expect(
    (
      await json(
        t.app,
        "/admin/whatsapp/rules",
        "PATCH",
        [
          {
            kind: "reminder_24h",
            templateId: "678901",
            variables: ["time"],
          },
        ],
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  expect((await t.db.select().from(reminder).where(eq(reminder.id, jobId)))[0]?.status).toBe(
    "pending",
  );
  const renewed = whatsappSettingsSchema.parse(await (await connect()).json());
  expect(renewed.connection?.rules).toHaveLength(1);

  await t.db.update(reminder).set({ whatsappDispatchAt: NOW }).where(eq(reminder.id, jobId));

  const confirmed = await t.app.request(
    `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=12345`,
  );
  expect(await confirmed.text()).toBe("12345");
  function delivery(status: string, signed: boolean, sender = originalSender) {
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [
        {
          id: sender.wabaId,
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: sender.phoneId },
                statuses: [{ id: "wamid.synthetic", biz_opaque_callback_data: jobId, status }],
              },
            },
          ],
        },
      ],
    });
    return t.app.request("/whatsapp/webhook", {
      method: "POST",
      headers: signed
        ? {
            "x-hub-signature-256":
              "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
          }
        : {},
      body,
    });
  }
  expect((await delivery("delivered", false)).status).toBe(403);
  const deliveryState = async () =>
    (await t.db.select().from(reminder).where(eq(reminder.id, jobId)))[0];
  expect((await delivery("sent", true)).status).toBe(204);
  expect((await deliveryState())?.whatsappDelivery).toBeNull();
  await t.db
    .update(reminder)
    .set({ providerMessageId: "wamid.synthetic" })
    .where(eq(reminder.id, jobId));
  expect((await delivery("sent", true)).status).toBe(204);
  expect((await deliveryState())?.whatsappDelivery).toBe("sent");

  await t.db
    .update(reminder)
    .set({
      whatsappDispatchWabaId: originalSender.wabaId,
      whatsappDispatchPhoneId: originalSender.phoneId,
      providerMessageId: null,
      whatsappDelivery: null,
    })
    .where(eq(reminder.id, jobId));
  expect((await json(t.app, "/admin/whatsapp", "DELETE", undefined, owner.cookie)).status).toBe(
    200,
  );
  expect((await delivery("delivered", true)).status).toBe(204);
  expect(await deliveryState()).toMatchObject({
    whatsappDelivery: "delivered",
    providerMessageId: "wamid.synthetic",
  });
  const replacement = { wabaId: "567890", phoneId: "987654" };
  graphPhoneId = replacement.phoneId;
  expect((await connect(replacement.phoneId, replacement.wabaId)).status).toBe(200);
  for (const sender of [
    replacement,
    { ...originalSender, phoneId: replacement.phoneId },
    { ...originalSender, wabaId: replacement.wabaId },
  ]) {
    expect((await delivery("read", true, sender)).status).toBe(204);
    expect((await deliveryState())?.whatsappDelivery).toBe("delivered");
  }
  expect((await delivery("read", true)).status).toBe(204);
  expect((await delivery("delivered", true)).status).toBe(204);
  expect((await deliveryState())?.whatsappDelivery).toBe("read");
  const [visit] = await t.db.select().from(appointment).where(eq(appointment.id, id));
  expect(visit?.status).toBe("booked");
});

test("saving automation rules after a note change does not schedule a second reminder for the same visit", async () => {
  expect((await connect()).status).toBe(200);
  await t.db
    .update(clientProfile)
    .set({ phone: "+34600000001" })
    .where(eq(clientProfile.id, f.clientId));
  const rules = [{ kind: "reminder_24h", templateId: "678901", variables: ["time"] }];
  expect((await json(t.app, "/admin/whatsapp/rules", "PATCH", rules, owner.cookie)).status).toBe(
    200,
  );
  const res = await json(
    t.app,
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    },
    owner.cookie,
  );
  expect(res.status).toBe(201);
  const visit = (await res.json()) as { id: string; version: number };
  expect(
    (
      await json(
        t.app,
        `/appointments/${visit.id}`,
        "PATCH",
        { notes: "Synthetic note", version: visit.version },
        owner.cookie,
      )
    ).status,
  ).toBe(200);
  expect((await json(t.app, "/admin/whatsapp/rules", "PATCH", rules, owner.cookie)).status).toBe(
    200,
  );
  expect(await t.db.select().from(reminder).where(eq(reminder.channel, "whatsapp"))).toHaveLength(
    1,
  );
});

test("a reviewed WhatsApp write cannot replace automation saved in another session", async () => {
  expect((await connect()).status).toBe(200);
  const desk = await json(t.app, "/admin/whatsapp/desk", "GET", undefined, owner.cookie);
  const { connection } = (await desk.json()) as { connection: { revision: string } };
  expect(connection.revision).toMatch(/^[a-f0-9]{64}$/);
  const before = await json(t.app, "/sync/pull", "GET", undefined, owner.cookie);
  const { headSeq } = syncPullResponseSchema.parse(await before.json());
  const save = (kind: string) =>
    json(
      t.app,
      "/admin/whatsapp/rules/reviewed",
      "PATCH",
      {
        revision: connection.revision,
        rules: [{ kind, templateId: "678901", variables: ["time"] }],
      },
      owner.cookie,
    );
  const results = await Promise.all([save("reminder_24h"), save("reminder_2h")]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  const rejected = results.find((r) => r.status === 409);
  expect(await rejected?.json()).toMatchObject({ error: { code: "version_conflict" } });
  const committed = results.find((r) => r.status === 200);
  const saved = whatsappSettingsSchema.parse(await committed?.json());
  expect(saved.connection?.rules).toHaveLength(1);
  const old = await json(
    t.app,
    `/sync/pull?since=${headSeq}&whatsappDesk=1`,
    "GET",
    undefined,
    owner.cookie,
  );
  const updated = await json(
    t.app,
    `/sync/pull?since=${headSeq}&whatsappSettings=1`,
    "GET",
    undefined,
    owner.cookie,
  );
  expect(syncPullResponseSchema.parse(await old.json()).refresh).toEqual(["whatsapp_desk"]);
  expect(syncPullResponseSchema.parse(await updated.json()).refresh).toEqual(["whatsapp_settings"]);
  expect((await save("confirmation")).status).toBe(409);
});

test("a reviewed disconnect cannot remove a sender renewed in another session", async () => {
  const first = whatsappSettingsSchema.parse(await (await connect()).json());
  const review = first.connection?.revision;
  expect(review).toBeDefined();
  const renewed = whatsappSettingsSchema.parse(await (await connect()).json());
  expect(renewed.connection?.revision).not.toBe(review);
  const path = "/admin/whatsapp/disconnect/reviewed";
  const staff = await actor(t, "staff", "staff@example.com", { staffProfileId: f.anaId });
  expect((await json(t.app, path, "POST", { revision: review })).status).toBe(401);
  expect((await json(t.app, path, "POST", { revision: review }, staff.cookie)).status).toBe(403);
  const stale = await json(t.app, path, "POST", { revision: review }, owner.cookie);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "version_conflict" } });
  expect(await t.db.select().from(whatsappConnection)).toHaveLength(1);
  const appointmentResponse = await json(
    t.app,
    "/appointments",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    },
    owner.cookie,
  );
  expect(appointmentResponse.status).toBe(201);
  const visit = (await appointmentResponse.json()) as { id: string; version: number };
  await t.db.insert(reminder).values([
    {
      appointmentId: visit.id,
      appointmentVersion: visit.version,
      channel: "whatsapp",
      scheduledFor: NOW,
      kind: "confirmation",
      status: "pending",
    },
    {
      appointmentId: visit.id,
      appointmentVersion: visit.version,
      channel: "whatsapp",
      scheduledFor: NOW,
      kind: "reminder_24h",
      status: "processing",
      whatsappDispatchAt: NOW,
    },
    {
      appointmentId: visit.id,
      appointmentVersion: visit.version,
      channel: "whatsapp",
      scheduledFor: NOW,
      kind: "reminder_2h",
      status: "sent",
      whatsappDelivery: "delivered",
    },
  ]);
  const success = await json(
    t.app,
    path,
    "POST",
    { revision: renewed.connection?.revision },
    owner.cookie,
  );
  expect(success.status).toBe(200);
  expect(whatsappSettingsSchema.parse(await success.json()).connection).toBeNull();
  expect(await t.db.select().from(whatsappConnection)).toHaveLength(0);
  const retained = await t.db.select().from(reminder).where(eq(reminder.channel, "whatsapp"));
  const history = await json(t.app, "/admin/whatsapp/desk", "GET", undefined, owner.cookie);
  const { deliveries } = whatsappDeskSchema.parse(await history.json());
  expect(deliveries.map((row) => row.kind).sort()).toEqual(["reminder_24h", "reminder_2h"]);
  expect(retained.find((row) => row.kind === "confirmation")?.status).toBe("cancelled");
  expect(retained.find((row) => row.kind === "reminder_24h")?.status).toBe("processing");
  expect(retained.find((row) => row.kind === "reminder_2h")).toMatchObject({
    status: "sent",
    whatsappDelivery: "delivered",
  });
  expect(
    (await json(t.app, path, "POST", { revision: renewed.connection?.revision }, owner.cookie))
      .status,
  ).toBe(200);
});

test("reviewed Embedded Signup rejects a stale renewal before exchanging the Meta code", async () => {
  const initial = await json(t.app, "/admin/whatsapp", "GET", undefined, owner.cookie);
  const oldSignup = whatsappSettingsSchema.parse(await initial.json()).signupRevision;
  const original = whatsappSettingsSchema.parse(await (await connect()).json());
  const revision = original.connection?.revision;
  const disconnected = await json(
    t.app,
    "/admin/whatsapp/disconnect/reviewed",
    "POST",
    { revision },
    owner.cookie,
  );
  expect(disconnected.status).toBe(200);
  const review = (expected: string | undefined) =>
    json(
      t.app,
      "/admin/whatsapp/connect/reviewed",
      "POST",
      {
        code: "synthetic-login-code",
        ...originalSender,
        revision: expected,
      },
      owner.cookie,
    );
  const callsBefore = calls.length;
  const stale = await review(revision);
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "version_conflict" } });
  expect(calls).toHaveLength(callsBefore);
  expect(await t.db.select().from(whatsappConnection)).toHaveLength(0);

  expect((await review(oldSignup)).status).toBe(409);
  expect(calls).toHaveLength(callsBefore);
  const current = await json(t.app, "/admin/whatsapp", "GET", undefined, owner.cookie);
  const newSignup = whatsappSettingsSchema.parse(await current.json()).signupRevision;
  expect(newSignup).toMatch(/^[a-f0-9]{64}$/);
  expect(whatsappSettingsSchema.parse(await disconnected.json()).signupRevision).toBe(newSignup);
  expect(newSignup).not.toEqual(oldSignup);
  const connected = await review(newSignup);
  expect(connected.status).toBe(200);
  expect(whatsappSettingsSchema.parse(await connected.json()).connection?.phone).toBe(
    "+34 611 000 000",
  );
  const after = calls.length;
  expect((await review(newSignup)).status).toBe(409);
  expect(calls).toHaveLength(after);
});

test.each(["committed", "failed"] as const)(
  "saving reviewed rules waits for a %s renewal before comparing the revision",
  async (outcome) => {
    const original = whatsappSettingsSchema.parse(await (await connect()).json());
    const revision = original.connection?.revision;
    const exchanged = Promise.withResolvers<void>();
    const templates = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<Response | undefined>();
    pauseExchange = () => {
      exchanged.resolve();
      return resume.promise;
    };
    onTemplates = templates.resolve;
    const renewal = json(
      t.app,
      "/admin/whatsapp/connect/reviewed",
      "POST",
      { code: "synthetic-login-code", ...originalSender, revision },
      owner.cookie,
    );
    try {
      await Promise.race([
        exchanged.promise,
        Promise.resolve(renewal).then((response) => {
          throw new Error(
            `The renewal finished before exchanging the code with ${response.status}`,
          );
        }),
      ]);
      const edit = json(
        t.app,
        "/admin/whatsapp/rules/reviewed",
        "PATCH",
        { revision, rules: [{ kind: "confirmation", templateId: "678901", variables: ["time"] }] },
        owner.cookie,
      );
      await Promise.race([
        templates.promise,
        Promise.resolve(edit).then((response) => {
          throw new Error(
            `The rule edit finished before loading templates with ${response.status}`,
          );
        }),
      ]);
      resume.resolve(outcome === "failed" ? new Response(null, { status: 400 }) : undefined);
      const response = await edit;
      if (outcome === "committed") {
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "version_conflict" } });
        expect((await renewal).status).toBe(200);
      } else {
        expect(response.status).toBe(200);
        expect(whatsappSettingsSchema.parse(await response.json()).connection?.rules).toHaveLength(
          1,
        );
        expect((await renewal).ok).toBe(false);
      }
    } finally {
      pauseExchange = undefined;
      onTemplates = undefined;
      resume.resolve(undefined);
      await renewal;
    }
  },
);
