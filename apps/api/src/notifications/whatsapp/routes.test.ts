import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { whatsappSettingsSchema } from "@sob/contracts";
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
const graph = (async (url: URL) => {
  calls.push(url.pathname);
  if (url.pathname.endsWith("/oauth/access_token"))
    return Response.json({ access_token: "synthetic-credential" });
  if (url.pathname.endsWith("/phone_numbers"))
    return Response.json({
      data: [
        {
          id: graphPhoneId,
          display_phone_number: "+34 611 000 000",
          is_on_biz_app: true,
          platform_type: "CLOUD_API",
        },
      ],
    });
  if (url.pathname.endsWith("/subscribed_apps")) return Response.json({ success: true });
  if (url.pathname.endsWith("/message_templates"))
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
