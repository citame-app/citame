import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { appointment, appointmentService, auditLog, clientProfile, service } from "@sob/db";
import { eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let customer: Actor;
let stranger: Actor;
const call = async (who: Actor | null, path: string, method = "GET", input?: unknown) =>
  json(t.app, path, method, input, who?.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "client_merge" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, customer, stranger] = await Promise.all([
    actor(t, "owner", "owner@merge.test"),
    actor(t, "client", "customer@merge.test"),
    actor(t, "client", "stranger@merge.test"),
  ]);
  await t.db
    .update(clientProfile)
    .set({
      name: "Possible duplicate",
      email: "customer@merge.test",
      notes: "Private original source note",
    })
    .where(eq(clientProfile.id, f.clientId));
});
function pair() {
  if (!customer.clientId) throw new Error("Missing customer");
  return { sourceId: f.clientId, targetId: customer.clientId };
}
async function preview(input = pair(), who = owner) {
  const r = await call(who, "/admin/clients/merge/preview", "POST", input);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await r.json()) as { reviewHash: string; canMerge: boolean; reasons: string[] };
}
async function merge(input = pair(), key = crypto.randomUUID()) {
  const p = await preview(input);
  return call(owner, "/admin/clients/merge", "POST", {
    ...input,
    reviewHash: p.reviewHash,
    confirmedSamePerson: true,
    idempotencyKey: key,
  });
}
async function book(clientId: string, startsAt = MONDAY_0900) {
  const r = await call(owner, "/appointments", "POST", {
    clientId,
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt,
  });
  expect(r.status, await r.clone().text()).toBe(201);
  return (await r.json()) as { id: string; version: number };
}
test("a reviewed walk-in duplicate joins the surviving directory and customer history without rewriting visits", async () => {
  const before = await book(f.clientId);
  await book(pair().targetId, "2026-03-09T13:00:00Z");
  const p = await preview();
  expect(p.canMerge).toBe(true);
  const r = await call(owner, "/admin/clients/merge", "POST", {
    ...pair(),
    reviewHash: p.reviewHash,
    confirmedSamePerson: true,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(r.status, await r.clone().text()).toBe(201);
  const [original] = await t.db.select().from(appointment).where(eq(appointment.id, before.id));
  expect(original?.clientId).toBe(f.clientId);
  const directory = await call(owner, "/admin/clients?search=customer%40merge.test");
  expect(await directory.json()).toMatchObject({ total: 1 });
  const own = await call(
    customer,
    "/appointments?from=2026-03-09T00:00:00Z&to=2026-03-10T00:00:00Z",
  );
  const body = (await own.json()) as { appointments: { id: string }[] };
  expect(body.appointments).toHaveLength(2);
  expect(body.appointments.map((row) => row.id)).toContain(before.id);
  const detail = await call(owner, `/admin/clients/${pair().targetId}`);
  expect(await detail.json()).toMatchObject({ client: { appointmentCount: 2 } });
  const edits = await call(owner, `/admin/clients/${f.clientId}`, "PATCH", {
    name: "Stale alias edit",
  });
  expect(edits.status).toBe(409);
  expect(await edits.json()).toMatchObject({ error: { code: "client_merged" } });
});
test("source accounts cannot be absorbed and no unprivileged actor can preview or merge identities", async () => {
  const staff = await actor(t, "staff", "staff@merge.test", { staffProfileId: f.anaId });
  for (const who of [null, customer, staff])
    expect((await call(who, "/admin/clients/merge/preview", "POST", pair())).status).toBe(
      who ? 403 : 401,
    );
  const p = await preview({ sourceId: pair().targetId, targetId: f.clientId });
  expect(p.canMerge).toBe(false);
  expect(p.reasons).toContain("source_account");
  expect(
    (
      await call(owner, "/admin/clients/merge", "POST", {
        sourceId: pair().targetId,
        targetId: f.clientId,
        reviewHash: p.reviewHash,
        confirmedSamePerson: true,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
});
test("changed contacts invalidate a review and uncertain retries retain one original immutable receipt", async () => {
  const p = await preview();
  const input = {
    ...pair(),
    reviewHash: p.reviewHash,
    confirmedSamePerson: true,
    idempotencyKey: crypto.randomUUID(),
  };
  await t.db
    .update(clientProfile)
    .set({ phone: "+34 600 111 222" })
    .where(eq(clientProfile.id, pair().targetId));
  expect((await call(owner, "/admin/clients/merge", "POST", input)).status).toBe(409);
  const current = await preview();
  const packet = { ...input, reviewHash: current.reviewHash };
  const a = await call(owner, "/admin/clients/merge", "POST", packet);
  expect(a.status, await a.clone().text()).toBe(201);
  const first = (await a.json()) as { id: string };
  const b = await call(owner, "/admin/clients/merge", "POST", packet);
  expect(b.status).toBe(201);
  expect(await b.json()).toMatchObject({ id: first.id });
  const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, "client.merge"));
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain("Private original source note");
  const wrong = await call(owner, "/admin/clients/merge", "POST", {
    ...packet,
    targetId: stranger.clientId,
  });
  expect(wrong.status).toBe(409);
});
test("blocking is preserved and merged source profiles cannot receive new stale offline bookings", async () => {
  await t.db
    .update(clientProfile)
    .set({
      bookingAccess: "blocked",
      bookingAccessReason: "Private original access restriction",
      tags: ["original"],
    })
    .where(eq(clientProfile.id, f.clientId));
  const r = await merge();
  expect(r.status, await r.clone().text()).toBe(201);
  const controls = await call(owner, `/admin/clients/${pair().targetId}/controls`);
  expect(await controls.json()).toMatchObject({ bookingAccess: "blocked", tags: ["original"] });
  const stale = await call(owner, "/appointments", "POST", {
    clientId: f.clientId,
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "client_merged" } });
  const fresh = await call(customer, "/appointments", "POST", {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
  });
  expect(fresh.status).toBe(403);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});
test("a booking queued behind an identity link cannot commit under the now-stale source profile", async () => {
  const p = await preview();
  let unlock = () => {};
  let locked = () => {};
  const held = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const blocker = t.db.transaction(async (tx) => {
    await tx.select().from(clientProfile).where(eq(clientProfile.id, f.clientId)).for("update");
    locked();
    await gate;
  });
  await held;
  const { sql } = await import("drizzle-orm");
  async function waiting(kind: "merge" | "booking") {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and query ilike '%client_profile%' and query ilike '%for update%' and (case when ${kind}='booking' then query ilike '%booking_access_reason%' else query not ilike '%booking_access_reason%' end)`,
      );
      if (rows.length) return;
      await Bun.sleep(10);
    }
    throw new Error(`No verified ${kind} row-lock wait`);
  }
  let merging: Promise<Response> | undefined;
  let booking: Promise<Response> | undefined;
  try {
    merging = call(owner, "/admin/clients/merge", "POST", {
      ...pair(),
      reviewHash: p.reviewHash,
      confirmedSamePerson: true,
      idempotencyKey: crypto.randomUUID(),
    });
    await waiting("merge");
    booking = call(owner, "/appointments", "POST", {
      clientId: f.clientId,
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
    });
    await waiting("booking");
    unlock();
    await blocker;
    expect((await merging).status).toBe(201);
    const response = await booking;
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "client_merged" } });
    expect(await t.db.select().from(appointment)).toHaveLength(0);
  } finally {
    unlock();
    await blocker;
    await Promise.allSettled([merging, booking].filter(Boolean));
  }
}, 30000);
test("joined point credits remain conserved and concurrent redemptions cannot spend the same group balance twice", async () => {
  const policy = (await (await call(owner, "/admin/rewards/policy")).json()) as Record<
    string,
    unknown
  >;
  expect(
    (
      await call(owner, "/admin/rewards/policy", "PUT", {
        ...policy,
        enabled: true,
        redeemValueCents: 10,
        maximumDiscountBasisPoints: 2000,
      })
    ).status,
  ).toBe(200);
  for (const id of [f.clientId, pair().targetId])
    expect(
      (
        await call(owner, `/admin/rewards/clients/${id}/adjustments`, "POST", {
          points: 100,
          reason: "Verified synthetic opening balance",
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
    ).toBe(201);
  const before = await call(owner, "/admin/commerce/checkouts", "POST", {
    clientId: f.clientId,
    lines: [
      {
        kind: "custom",
        description: "Original source receipt",
        quantity: 1,
        unitAmountCents: 10000,
      },
    ],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(before.status).toBe(201);
  const original = (await before.json()) as { id: string };
  expect((await merge()).status).toBe(201);
  const balance = await call(customer, "/me/rewards");
  expect(await balance.json()).toMatchObject({ availablePoints: 200 });
  expect((await call(customer, `/me/checkouts/${original.id}`)).status).toBe(200);
  expect((await call(stranger, `/me/checkouts/${original.id}`)).status).toBe(404);
  const sales = [original];
  for (let i = 0; i < 1; i++) {
    const r = await call(owner, "/admin/commerce/checkouts", "POST", {
      clientId: pair().targetId,
      lines: [
        {
          kind: "custom",
          description: "New group redemption",
          quantity: 1,
          unitAmountCents: 10000,
        },
      ],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(r.status).toBe(201);
    sales.push((await r.json()) as { id: string });
  }
  const applied = await Promise.all(
    sales.map((row) =>
      call(customer, `/me/checkouts/${row.id}/reward`, "POST", {
        kind: "points",
        points: 150,
        expectedTotalCents: 10000,
        expectedDiscountCents: 1500,
        idempotencyKey: crypto.randomUUID(),
      }),
    ),
  );
  expect(applied.filter((r) => r.status === 200)).toHaveLength(1);
  expect(applied.filter((r) => r.status === 409)).toHaveLength(1);
  expect(await (await call(customer, "/me/rewards")).json()).toMatchObject({
    availablePoints: 50,
    reservedPoints: 150,
  });
  const { loyaltyLot, checkout } = await import("@sob/db");
  const lots = await t.db.select().from(loyaltyLot);
  expect(new Set(lots.map((row) => row.clientId))).toEqual(new Set([f.clientId, pair().targetId]));
  const [stored] = await t.db.select().from(checkout).where(eq(checkout.id, original.id));
  expect(stored?.clientId).toBe(f.clientId);
});
test("a merge does not reset a customer's coupon usage limit", async () => {
  const created = await call(owner, "/admin/rewards/promotions", "POST", {
    code: "ONCEONLY",
    name: "One identity, one use",
    kind: "fixed",
    value: 500,
    perClientLimit: 1,
  });
  expect(created.status, await created.clone().text()).toBe(201);
  async function discountedSale(clientId: string) {
    const response = await call(owner, "/admin/commerce/checkouts", "POST", {
      clientId,
      lines: [
        { kind: "custom", description: "Eligible sale", quantity: 1, unitAmountCents: 10000 },
      ],
      idempotencyKey: crypto.randomUUID(),
    });
    expect(response.status).toBe(201);
    const row = (await response.json()) as { id: string };
    return call(owner, `/admin/commerce/checkouts/${row.id}/reward`, "POST", {
      kind: "promotion",
      code: "ONCEONLY",
      expectedTotalCents: 10000,
      expectedDiscountCents: 500,
      idempotencyKey: crypto.randomUUID(),
    });
  }
  const first = await discountedSale(f.clientId);
  expect(first.status, await first.clone().text()).toBe(200);
  expect((await merge()).status).toBe(201);
  const second = await discountedSale(pair().targetId);
  expect(second.status, await second.clone().text()).toBe(409);
});
test("paid source gifts and visit packages stay private and usable without rewriting the original buyer", async () => {
  await t.db.update(service).set({ currency: "EUR" });
  const planned = await call(owner, "/admin/benefit-plans", "POST", {
    name: "Original funded visit",
    kind: "package",
    priceCents: 1000,
    includedUses: 1,
    serviceIds: [f.haircutId],
    idempotencyKey: crypto.randomUUID(),
  });
  expect(planned.status).toBe(201);
  const plan = (await planned.json()) as { id: string };
  const purchased = await call(owner, "/admin/passes", "POST", {
    planId: plan.id,
    clientId: f.clientId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(purchased.status).toBe(201);
  const pass = (await purchased.json()) as {
    pass: { id: string };
    period: { id: string };
    checkout: { id: string };
  };
  const bought = await call(owner, "/admin/gift-cards", "POST", {
    amountCents: 1000,
    buyerClientId: f.clientId,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(bought.status).toBe(201);
  const gift = (await bought.json()) as { card: { id: string }; checkout: { id: string } };
  for (const id of [pass.checkout.id, gift.checkout.id]) {
    const paid = await call(owner, `/admin/commerce/checkouts/${id}/payments`, "POST", {
      method: "external_card",
      amountCents: 1000,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(paid.status, await paid.clone().text()).toBe(201);
  }
  expect((await merge()).status).toBe(201);
  expect((await call(customer, `/me/passes/${pass.pass.id}`)).status).toBe(200);
  expect((await call(stranger, `/me/passes/${pass.pass.id}`)).status).toBe(404);
  expect((await call(customer, `/me/gift-cards/${gift.card.id}`)).status).toBe(200);
  expect((await call(stranger, `/me/gift-cards/${gift.card.id}`)).status).toBe(404);
  const start = new Date(Date.now() + 86400000);
  const [visit] = await t.db
    .insert(appointment)
    .values({
      staffId: f.anaId,
      clientId: pair().targetId,
      startsAt: start,
      endsAt: new Date(start.getTime() + 3600000),
    })
    .returning();
  if (!visit) throw new Error("Missing visit");
  await t.db.insert(appointmentService).values({
    appointmentId: visit.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Original service",
    durationMinutes: 45,
    bufferMinutes: 15,
    priceCents: 2000,
    currency: "EUR",
  });
  const sale = await call(owner, "/admin/commerce/checkouts", "POST", {
    appointmentId: visit.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(sale.status).toBe(201);
  const receipt = (await sale.json()) as { id: string; lines: { id: string }[] };
  const used = await call(customer, `/me/checkouts/${receipt.id}/payments`, "POST", {
    method: "package",
    passPeriodId: pass.period.id,
    checkoutLineId: receipt.lines[0]?.id,
    amountCents: 2000,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(used.status, await used.clone().text()).toBe(201);
  const { passContract, giftCard } = await import("@sob/db");
  const [originalPass] = await t.db
    .select()
    .from(passContract)
    .where(eq(passContract.id, pass.pass.id));
  const [originalGift] = await t.db.select().from(giftCard).where(eq(giftCard.id, gift.card.id));
  expect(originalPass?.clientId).toBe(f.clientId);
  expect(originalGift?.buyerClientId).toBe(f.clientId);
});
test("private photos and form history follow the identity without creating fresh consent", async () => {
  const { default: sharp } = await import("sharp");
  const image = await sharp({
    create: { width: 20, height: 20, channels: 3, background: "#90485a" },
  })
    .jpeg()
    .toBuffer();
  const upload = {
    caption: "Original private photo",
    permissionConfirmed: true,
    imageBase64: image.toString("base64"),
    idempotencyKey: crypto.randomUUID(),
  };
  const uploaded = await call(owner, `/admin/clients/${f.clientId}/photos`, "POST", upload);
  expect(uploaded.status).toBe(201);
  const photo = (await uploaded.json()) as { id: string };
  const field = crypto.randomUUID();
  const created = await call(owner, "/admin/intake-forms", "POST", {
    idempotencyKey: crypto.randomUUID(),
    definition: {
      title: "Original private consent",
      description: "Synthetic statement",
      fields: [{ id: field, kind: "text", label: "Your response", required: true }],
      allServices: true,
      serviceIds: [],
      requiredAtBooking: true,
      allowTeamResponses: true,
    },
  });
  expect(created.status, await created.clone().text()).toBe(201);
  const draft = (await created.json()) as { id: string; version: number };
  const published = await call(owner, `/admin/intake-forms/${draft.id}/publish`, "POST", {
    version: draft.version,
  });
  expect(published.status).toBe(200);
  const form = (await published.json()) as { published: { id: string } };
  const packet = {
    revisionId: form.published.id,
    confirmation: true,
    answers: { [field]: "Private original statement" },
    idempotencyKey: crypto.randomUUID(),
  };
  const submitted = await call(owner, `/admin/clients/${f.clientId}/intake`, "POST", packet);
  expect(submitted.status, await submitted.clone().text()).toBe(201);
  const statement = (await submitted.json()) as { id: string };
  expect((await merge()).status).toBe(201);
  const photos = await call(owner, `/admin/clients/${pair().targetId}/photos`);
  expect(await photos.json()).toMatchObject({ photos: [{ id: photo.id, clientId: f.clientId }] });
  expect(
    (await call(owner, `/admin/clients/${pair().targetId}/photos/${photo.id}/image`)).status,
  ).toBe(200);
  expect((await call(customer, `/intake/submissions/${statement.id}`)).status).toBe(200);
  expect((await call(stranger, `/intake/submissions/${statement.id}`)).status).toBe(404);
  expect(await (await call(customer, "/me/intake")).json()).toMatchObject({
    submissions: [{ id: statement.id, clientId: f.clientId }],
  });
  const requirements = await call(customer, `/intake/requirements?serviceIds=${f.haircutId}`);
  expect(JSON.stringify(await requirements.json())).not.toContain(statement.id);
  const stale = await call(owner, `/admin/clients/${f.clientId}/intake`, "POST", {
    ...packet,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(stale.status).toBe(409);
  const oldUpload = await call(owner, `/admin/clients/${f.clientId}/photos`, "POST", {
    ...upload,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(oldUpload.status).toBe(409);
});
test("a source unsubscribe suppresses the survivor until the customer explicitly changes that preference", async () => {
  const { notificationPreference } = await import("@sob/db");
  await t.db
    .insert(notificationPreference)
    .values({ clientId: f.clientId, channel: "email", category: "reminder", enabled: false });
  expect((await merge()).status).toBe(201);
  expect(await (await call(customer, "/me/notification-preferences")).json()).toMatchObject({
    email: { reminder: false },
  });
  const { isEnabled } = await import("../../notifications/preferences");
  expect(await isEnabled(t.db, f.clientId, "email", "reminder")).toBe(false);
  expect(await isEnabled(t.db, pair().targetId, "email", "reminder")).toBe(false);
  const changed = await call(customer, "/me/notification-preferences", "PATCH", {
    email: { reminder: true },
  });
  expect(changed.status, await changed.clone().text()).toBe(200);
  expect(await isEnabled(t.db, f.clientId, "email", "reminder")).toBe(true);
  const { signOptOutToken } = await import("../../notifications/tokens");
  const token = signOptOutToken(t.config.notifications.signingSecret, {
    clientId: f.clientId,
    channel: "email",
  });
  expect((await call(null, "/notifications/opt-out", "POST", { token })).status).toBe(200);
  expect(await isEnabled(t.db, pair().targetId, "email", "reminder")).toBe(false);
});
test("historic contacts find one survivor in search and CSV review while source notes remain labelled history", async () => {
  await t.db
    .update(clientProfile)
    .set({ email: "original@identity.test", phone: "+34 600 222 333" })
    .where(eq(clientProfile.id, f.clientId));
  expect((await merge()).status).toBe(201);
  const directory = await call(owner, "/admin/clients?search=original%40identity.test");
  expect(await directory.json()).toMatchObject({ total: 1, clients: [{ id: pair().targetId }] });
  const source = await call(owner, `/admin/clients/${f.clientId}`);
  expect(await source.json()).toMatchObject({
    identity: {
      rootId: pair().targetId,
      profiles: expect.arrayContaining([
        {
          id: f.clientId,
          name: "Possible duplicate",
          email: "original@identity.test",
          phone: "+34 600 222 333",
          notes: "Private original source note",
        },
      ]),
    },
  });
  const imported = await call(owner, "/admin/clients/import/preview", "POST", {
    csv: "name,email,phone,notes,tags\nOriginal contact,original@identity.test,+34600222333,,\n",
  });
  expect(imported.status).toBe(200);
  expect(await imported.json()).toMatchObject({
    rows: [{ status: "duplicate", matches: [{ id: pair().targetId }] }],
  });
  const exported = await call(owner, "/admin/clients/export");
  expect(exported.status).toBe(200);
  const result = (await exported.json()) as { csv: string };
  expect(result.csv).not.toContain("original@identity.test");
});
test("merged historic visits remain reviewable and synced aliases reject stale proposals explicitly", async () => {
  const [visit] = await t.db
    .insert(appointment)
    .values({
      clientId: f.clientId,
      staffId: f.anaId,
      status: "completed",
      startsAt: new Date("2026-03-01T12:00:00Z"),
      endsAt: new Date("2026-03-01T13:00:00Z"),
    })
    .returning();
  if (!visit) throw new Error("Missing historic visit");
  expect((await merge()).status).toBe(201);
  const reviews = await call(customer, "/me/reviews");
  expect(JSON.stringify(await reviews.json())).toContain(visit.id);
  const input = {
    appointmentId: visit.id,
    idempotencyKey: crypto.randomUUID(),
    publicName: "A.",
    rating: 5,
    body: "A completed synthetic visit.",
    shareServices: false,
    publicationConfirmed: true,
  };
  const review = await call(customer, "/me/reviews", "POST", input);
  expect(review.status, await review.clone().text()).toBe(201);
  const row = (await review.json()) as { id: string; version: number };
  expect((await call(customer, "/me/reviews", "POST", input)).status).toBe(201);
  expect(
    (await call(customer, `/me/reviews/${row.id}/withdraw`, "POST", { version: row.version }))
      .status,
  ).toBe(200);
  const { pullAll } = await import("../../../test/sync");
  const sync = await pullAll(t, owner);
  expect(
    sync.changes.find((change) => change.entity === "client" && change.id === f.clientId)?.data,
  ).toMatchObject({ mergedIntoId: pair().targetId });
  const { rejectionReason } = await import("../sync/apply");
  const { DomainError } = await import("../../errors");
  expect(
    rejectionReason(new DomainError("client_merged", "Review the current client")),
  ).toMatchObject({ reason: "conflict" });
});
test("new retail receipts preserve inventory-before-client locking under contention", async () => {
  const { retailProduct } = await import("@sob/db");
  const { sql } = await import("drizzle-orm");
  const [product] = await t.db
    .insert(retailProduct)
    .values({
      name: "Synthetic product",
      sku: "MERGE-LOCK",
      priceCents: 1000,
      stockOnHand: 10,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "a".repeat(64),
    })
    .returning();
  if (!product) throw new Error("Missing product");
  let release = () => {},
    signal = () => {};
  const ready = new Promise<void>((resolve) => {
    signal = resolve;
  });

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = t.db.transaction(async (tx) => {
    await tx.select().from(retailProduct).where(eq(retailProduct.id, product.id)).for("update");
    signal();
    await gate;
    await tx.execute(
      sql`select id from client_profile where id=${pair().targetId}::uuid for update nowait`,
    );
  });
  await ready;
  const selling = call(owner, "/admin/commerce/checkouts", "POST", {
    clientId: pair().targetId,
    lines: [{ kind: "product", productId: product.id, quantity: 1 }],
    idempotencyKey: crypto.randomUUID(),
  });
  try {
    const deadline = Date.now() + 2000;
    let waited = false;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock' and query ilike '%retail_product%' and query ilike '%for update%'`,
      );
      if (rows.length) {
        waited = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waited).toBe(true);
    release();
    const [held, sale] = await Promise.allSettled([holder, selling]);
    expect(held.status).toBe("fulfilled");
    expect(sale.status).toBe("fulfilled");
    if (sale.status === "fulfilled") expect(sale.value.status).toBe(201);
  } finally {
    release();
    await Promise.allSettled([holder, selling]);
  }
}, 10000);
test("duplicate suggestions normalize contacts, disclose their match and never join shared family contacts automatically", async () => {
  await t.db
    .update(clientProfile)
    .set({ phone: "+34 (600) 555-123" })
    .where(eq(clientProfile.id, f.clientId));
  await t.db
    .update(clientProfile)
    .set({ phone: "34600555123", name: "Different family member" })
    .where(eq(clientProfile.id, pair().targetId));
  const found = await call(owner, `/admin/clients/${f.clientId}/duplicates`);
  expect(found.status, await found.clone().text()).toBe(200);
  const result = (await found.json()) as { candidates: { id: string; matchedBy: string[] }[] };
  expect(result.candidates.find((row) => row.id === pair().targetId)).toMatchObject({
    matchedBy: expect.arrayContaining(["phone"]),
    hasAccount: true,
  });
  expect(
    (await t.db.select().from(clientProfile).where(eq(clientProfile.id, f.clientId)))[0]
      ?.mergedIntoId,
  ).toBeNull();
  expect((await call(customer, `/admin/clients/${f.clientId}/duplicates`)).status).toBe(403);
});

test("merged waitlist requests remain visible but require a fresh subject before another offer", async () => {
  expect(
    (
      await call(owner, "/admin/waitlist/policy", "PUT", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).status,
  ).toBe(200);
  const selection = {
    clientId: f.clientId,
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    fromDate: "2026-03-09",
    toDate: "2026-03-09",
    fromTime: "09:00",
    toTime: "15:00",
    idempotencyKey: crypto.randomUUID(),
  };
  const joined = await call(owner, "/admin/waitlist", "POST", selection);
  expect(joined.status, await joined.clone().text()).toBe(201);
  const entry = (await joined.json()) as { id: string };
  expect((await merge()).status).toBe(201);
  expect(JSON.stringify(await (await call(customer, "/me/waitlist")).json())).toContain(entry.id);
  const { runWaitlist } = await import("../waitlist/matching");
  await runWaitlist(t.db, { now: new Date("2026-03-02T12:00:00Z") });
  const { waitlistEntry } = await import("@sob/db");
  const [row] = await t.db.select().from(waitlistEntry).where(eq(waitlistEntry.id, entry.id));
  expect(row?.state).toBe("unavailable");
  const stale = await call(owner, "/admin/waitlist", "POST", {
    ...selection,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(stale.status, await stale.clone().text()).toBe(409);
});
test("pending transactional notices use the current contact instead of an old alias address", async () => {
  await t.db
    .update(clientProfile)
    .set({ email: "old-address@identity.test" })
    .where(eq(clientProfile.id, f.clientId));
  await book(f.clientId);
  expect((await merge()).status).toBe(201);
  const { createNotificationWorker } = await import("../../notifications/worker");
  const { FakeEmailProvider } = await import("../../notifications/providers/fake");
  const email = new FakeEmailProvider();
  const worker = createNotificationWorker({
    db: t.db,
    config: t.config.notifications,
    providers: { email, sms: null },
    now: () => new Date("2026-03-02T12:00:00Z"),
    workerId: "merge-test",
    log: () => {},
  });
  await worker.runOnce();
  expect([...email.delivered.values()].map((message) => message.to)).toEqual([
    "customer@merge.test",
  ]);
});
