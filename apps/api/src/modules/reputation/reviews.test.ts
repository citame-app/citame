import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  campaignListSchema,
  ownReviewsSchema,
  publicReviewsSchema,
  reviewEmailRequestSchema,
  reviewPrivateSchema,
  reviewRequestsSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentService,
  auditLog,
  clientProfile,
  marketingDelivery,
  pgErrorCode,
  review,
  service,
  staffProfile,
  user,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { loadPrincipal } from "../../auth/principal";
import { FakeEmailProvider } from "../../notifications/providers/fake";
import type { Tx } from "../../tx";
import { createMarketingWorker } from "../marketing/worker";
import { changeReview } from "./reviews";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let customer: Actor;
let owner: Actor;
let day = 0;
beforeAll(async () => {
  t = await setupApiTest({
    dbSuffix: "reputation_reviews",
    env: {
      NOTIFY_WORKER_ENABLED: "false",
      NOTIFY_EXTERNAL_WORKER_ENABLED: "true",
      NOTIFY_EMAIL_PROVIDER: "smtp",
      SMTP_URL: "smtp://127.0.0.1:1",
    },
    deps: { emailProvider: new FakeEmailProvider() },
  });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  customer = await actor(t, "client", "reviewer@test.invalid");
  owner = await actor(t, "owner", "moderator@test.invalid");
  day = 0;
});
const call = (path: string, method = "GET", input?: unknown, who = customer) =>
  json(t.app, path, method, input, who.cookie);
async function visit(
  clientId = customer.clientId,
  status: "booked" | "completed" | "cancelled" | "no_show" = "completed",
  future = false,
) {
  if (!clientId) throw new Error("Missing client");
  const startsAt = new Date(NOW.getTime() + (future ? 1 : -1) * (++day * 86400000));
  const [row] = await t.db
    .insert(appointment)
    .values({
      clientId,
      staffId: f.anaId,
      status,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 1800000),
    })
    .returning();
  if (!row) throw new Error("Missing appointment");
  await t.db.insert(appointmentService).values({
    appointmentId: row.id,
    serviceId: f.haircutId,
    position: 0,
    name: "Original haircut",
    durationMinutes: 30,
    bufferMinutes: 0,
    priceCents: 2000,
    currency: "ARS",
  });
  return row;
}
const inputFor = (appointmentId: string) => ({
  appointmentId,
  idempotencyKey: crypto.randomUUID(),
  publicName: "A.",
  rating: 5,
  body: "A lovely completed visit.",
  shareServices: false,
  publicationConfirmed: true,
});
async function created(appointmentId: string, changes: Record<string, unknown> = {}) {
  const input = { ...inputFor(appointmentId), ...changes };
  const response = await call("/me/reviews", "POST", input);
  expect(response.status, await response.clone().text()).toBe(201);
  return {
    input,
    review: (await response.json()) as {
      id: string;
      version: number;
      status: string;
      body: string | null;
      reply: string | null;
    },
  };
}

test("review requests link only eligible unreviewed visits and preserve account ownership", async () => {
  const stranger = await actor(t, "client", "another@test.invalid");
  const staff = await actor(t, "staff", "staff@test.invalid", { staffProfileId: f.anaId });
  const first = await visit();
  const reviewed = await visit();
  await created(reviewed.id);
  const otherEligible = await visit(stranger.clientId);
  await visit(customer.clientId, "completed", true);
  await visit(customer.clientId, "no_show");
  await visit(f.clientId);
  const url = "/admin/reviews/requests?search=reviewer";
  expect((await call(url)).status).toBe(403);
  expect((await call(url, "GET", undefined, staff)).status).toBe(403);
  const result = await call(url, "GET", undefined, owner);
  expect(result.status).toBe(200);
  expect(result.headers.get("cache-control")).toBe("private, no-store");
  const requests = reviewRequestsSchema.parse(await result.json());
  expect(requests.visits.map((row) => row.appointmentId)).toEqual([first.id]);
  const unfiltered = await call("/admin/reviews/requests", "GET", undefined, owner);
  expect(
    reviewRequestsSchema.parse(await unfiltered.json()).visits.map((row) => row.appointmentId),
  ).toEqual([first.id, otherEligible.id]);
  const link = new URL(requests.visits[0]!.link!);
  expect(link.origin).toBe(new URL(t.config.notifications.publicUrl).origin);
  expect(link.pathname).toBe("/account/reviews");
  expect(link.searchParams.get("appointmentId")).toBe(first.id);
  const query = `/me/reviews${link.search}`;
  const own = ownReviewsSchema.parse(await (await call(query)).json());
  expect(own.visits.map((row) => row.appointmentId)).toEqual([first.id]);
  const other = ownReviewsSchema.parse(
    await (await call(query, "GET", undefined, stranger)).json(),
  );
  expect(other.visits).toEqual([]);

  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await call(url, "GET", undefined, staff)).status).toBe(200);

  const original = t.config.auth.requireEmailVerification;
  try {
    t.config.auth.requireEmailVerification = true;
    await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, customer.userId));
    const unverified = await call(url, "GET", undefined, owner);
    expect(reviewRequestsSchema.parse(await unverified.json()).visits).toEqual([]);
    await t.db.update(user).set({ emailVerified: true }).where(eq(user.id, customer.userId));
    const verified = await call(url, "GET", undefined, owner);
    expect(
      reviewRequestsSchema.parse(await verified.json()).visits.map((row) => row.appointmentId),
    ).toEqual([first.id]);
  } finally {
    t.config.auth.requireEmailVerification = original;
  }
});
async function publish(review: { id: string; version: number }) {
  const response = await call(
    `/admin/reviews/${review.id}/moderation`,
    "PUT",
    { version: review.version, status: "published" },
    owner,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ id: string; version: number; status: string }>;
}

const emailPath = (id: string) => `/admin/reviews/requests/${id}/email`;
async function consentEmail(enabled: boolean, version: number) {
  expect(
    (
      await call(
        `/admin/clients/${customer.clientId}/marketing-consent`,
        "PATCH",
        { channel: "email", enabled, version, source: "Explicit permission in test" },
        owner,
      )
    ).status,
  ).toBe(200);
}
const verifyCustomerEmail = () =>
  t.db.update(user).set({ emailVerified: true }).where(eq(user.id, customer.userId));
const reviewWorker = (email: FakeEmailProvider) =>
  createMarketingWorker({
    db: t.db,
    config: t.config.notifications,
    providers: { email, sms: null },
    now: () => NOW,
  });

test("a verified opted-in visit queues once and sends a private link with an opt-out", async () => {
  const target = await visit();
  const path = emailPath(target.id);
  const staff = await actor(t, "staff", "email-staff@test.invalid", { staffProfileId: f.anaId });
  expect((await call(path, "POST")).status).toBe(403);
  expect((await call(path, "POST", {}, staff)).status).toBe(403);
  expect((await call(path, "POST", {}, owner)).status).toBe(400);
  await t.db.update(user).set({ emailVerified: false }).where(eq(user.id, customer.userId));
  await consentEmail(true, 0);
  expect((await call(path, "POST", {}, owner)).status).toBe(400);
  await verifyCustomerEmail();

  const profile = eq(clientProfile.id, customer.clientId!);
  await t.db.update(clientProfile).set({ email: "alternate@test.invalid" }).where(profile);
  expect((await call(path, "POST", {}, owner)).status).toBe(400);
  await t.db.update(clientProfile).set({ email: "reviewer@test.invalid" }).where(profile);
  const listed = reviewRequestsSchema.parse(
    await (await call("/admin/reviews/requests", "GET", undefined, owner)).json(),
  );
  expect(listed).toMatchObject({
    emailEnabled: true,
    visits: [{ appointmentId: target.id, canEmail: true, emailStatus: null }],
  });
  expect(JSON.stringify(listed)).not.toContain("reviewer@test.invalid");

  for (const response of await Promise.all([
    call(path, "POST", {}, owner),
    call(path, "POST", {}, owner),
  ])) {
    expect(response.status, await response.clone().text()).toBe(200);
    expect(reviewEmailRequestSchema.parse(await response.json()).status).toBe("pending");
  }
  const email = new FakeEmailProvider();
  await Promise.all([reviewWorker(email).runOnce(), reviewWorker(email).runOnce()]);
  expect(email.calls).toHaveLength(1);
  const message = email.calls[0]!;
  const link = `${t.config.notifications.publicUrl}/account/reviews?appointmentId=${target.id}`;
  expect(message.to).toBe("reviewer@test.invalid");
  expect(message.text).toContain(link);
  expect(listed.visits[0]?.link).toBe(link);
  expect(message.html).toContain(`href="${link}"`);
  expect(message.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  expect(
    reviewEmailRequestSchema.parse(await (await call(path, "POST", {}, owner)).json()).status,
  ).toBe("sent");
  const [delivery] = await t.db.select().from(marketingDelivery);
  expect(delivery?.reviewAppointmentId).toBe(target.id);
  expect(
    campaignListSchema.parse(
      await (await call("/admin/marketing/campaigns", "GET", undefined, owner)).json(),
    ).campaigns,
  ).toEqual([]);
  expect(
    (await call(`/admin/marketing/campaigns/${delivery?.campaignId}`, "GET", undefined, owner))
      .status,
  ).toBe(404);
});

test("a queued invitation is skipped after opt-out, email changes or a submitted review", async () => {
  await verifyCustomerEmail();
  await consentEmail(true, 0);
  const revoked = await visit();
  expect((await call(emailPath(revoked.id), "POST", {}, owner)).status).toBe(200);
  await consentEmail(false, 1);
  const email = new FakeEmailProvider();
  const worker = reviewWorker(email);
  await worker.runOnce();

  await consentEmail(true, 2);
  const changed = await visit();
  expect((await call(emailPath(changed.id), "POST", {}, owner)).status).toBe(200);
  await t.db
    .update(clientProfile)
    .set({ email: "alternate@test.invalid" })
    .where(eq(clientProfile.id, customer.clientId!));
  await worker.runOnce();

  await t.db
    .update(clientProfile)
    .set({ email: "reviewer@test.invalid" })
    .where(eq(clientProfile.id, customer.clientId!));
  const reviewed = await visit();
  expect((await call(emailPath(reviewed.id), "POST", {}, owner)).status).toBe(200);
  await created(reviewed.id);
  await worker.runOnce();

  expect(email.calls).toHaveLength(0);
  const rows = await t.db.select().from(marketingDelivery);
  expect(new Map(rows.map((row) => [row.reviewAppointmentId, row.status]))).toEqual(
    new Map([
      [revoked.id, "skipped"],
      [changed.id, "skipped"],
      [reviewed.id, "skipped"],
    ]),
  );
  const after = reviewRequestsSchema.parse(
    await (await call("/admin/reviews/requests", "GET", undefined, owner)).json(),
  );
  expect(after.visits.find(({ appointmentId }) => appointmentId === reviewed.id)).toMatchObject({
    link: null,
    emailStatus: "skipped",
    canEmail: false,
  });
});

test("only the customer can review their own completed, elapsed appointment", async () => {
  for (const status of ["booked", "cancelled", "no_show"] as const) {
    const a = await visit(customer.clientId, status);
    expect((await call("/me/reviews", "POST", inputFor(a.id))).status).toBe(409);
  }
  expect(
    (
      await call(
        "/me/reviews",
        "POST",
        inputFor((await visit(customer.clientId, "completed", true)).id),
      )
    ).status,
  ).toBe(409);
  expect((await call("/me/reviews", "POST", inputFor((await visit(f.clientId)).id))).status).toBe(
    404,
  );
  const own = await visit();
  expect((await call("/me/reviews", "POST", inputFor(own.id), owner)).status).toBe(403);
  const { review } = await created(own.id);
  expect(review.status).toBe("pending");
  expect((await call("/me/reviews", "POST", inputFor(own.id))).status).toBe(409);
});
test("pending text is private; publication exposes chosen fields and optional frozen service names only", async () => {
  const a = await visit();
  const { review } = await created(a.id);
  let response = await json(t.app, "/reviews", "GET");
  expect(await response.json()).toMatchObject({ reviews: [], total: 0, average: null });
  expect((await json(t.app, "/admin/reviews", "GET")).status).toBe(401);
  await publish(review);
  response = await json(t.app, "/reviews", "GET");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const body = await response.json();
  expect(body).toMatchObject({
    total: 1,
    average: 5,
    reviews: [{ publicName: "A.", body: "A lovely completed visit.", services: [] }],
  });
  expect(JSON.stringify(body)).not.toContain(String(customer.clientId));
  expect(JSON.stringify(body)).not.toContain(a.id);
  expect(JSON.stringify(body)).not.toContain("reviewer@test.invalid");
  expect(
    await (await json(t.app, `/reviews?serviceId=${f.haircutId}`, "GET")).json(),
  ).toMatchObject({
    total: 0,
  });
  const shared = await created((await visit()).id, { shareServices: true, rating: 3 });
  await publish(shared.review);
  await t.db.update(service).set({ name: "Changed catalog" }).where(eq(service.id, f.haircutId));
  expect(
    await (await json(t.app, `/reviews?serviceId=${f.haircutId}`, "GET")).json(),
  ).toMatchObject({
    total: 1,
    average: 3,
    reviews: [{ services: [{ name: "Original haircut" }] }],
  });
  expect(await (await json(t.app, "/reviews", "GET")).json()).toMatchObject({
    total: 2,
    average: 4,
  });
});
test("uncertain create retries are actor-scoped, concurrent and cannot change or resurrect a withdrawn review", async () => {
  const input = inputFor((await visit()).id);
  const results = await Promise.all([
    call("/me/reviews", "POST", input),
    call("/me/reviews", "POST", input),
  ]);
  expect(results.map((r) => r.status)).toEqual([201, 201]);
  const review = reviewPrivateSchema.parse(await results[0]?.json());
  expect(await results[1]?.json()).toEqual(review);
  expect((await call("/me/reviews", "POST", { ...input, body: "Different" })).status).toBe(409);
  const withdrawn = await call(`/me/reviews/${review.id}/withdraw`, "POST", {
    version: review.version,
  });
  expect(withdrawn.status).toBe(200);
  expect(await withdrawn.json()).toMatchObject({
    status: "withdrawn",
    body: null,
    publicName: null,
    rating: null,
    reply: null,
  });
  expect(await (await call("/me/reviews", "POST", input)).json()).toMatchObject({
    id: review.id,
    status: "withdrawn",
    body: null,
  });
  const other = await actor(t, "client", "other@test.invalid");
  expect(
    (await call(`/me/reviews/${review.id}`, "PUT", { ...input, version: 2 }, other)).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await call(`/me/reviews/${review.id}/withdraw`, "POST", { version: 2 }, other)).status,
  ).toBe(404);
});
test("edits require new review and optimistic versions; replies and moderation cannot overwrite each other", async () => {
  const { review, input } = await created((await visit()).id);
  const published = await publish(review);
  const reply = await call(
    `/admin/reviews/${review.id}/reply`,
    "PUT",
    { version: published.version, reply: "Thank you!" },
    owner,
  );
  expect(reply.status).toBe(200);
  const replied = reviewPrivateSchema.parse(await reply.json());
  expect(
    (
      await call(
        `/admin/reviews/${review.id}/moderation`,
        "PUT",
        { version: published.version, status: "hidden", reason: "Privacy" },
        owner,
      )
    ).status,
  ).toBe(409);
  const { appointmentId: _appointment, idempotencyKey: _key, ...content } = input;
  const edited = await call(`/me/reviews/${review.id}`, "PUT", {
    ...content,
    version: replied.version,
    body: "Corrected review",
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({
    status: "pending",
    reply: null,
    body: "Corrected review",
  });
  expect(await (await json(t.app, "/reviews", "GET")).json()).toMatchObject({ total: 0 });
  expect(
    (
      await call(`/me/reviews/${review.id}`, "PUT", {
        ...content,
        version: replied.version,
        body: "Stale",
      })
    ).status,
  ).toBe(409);
});
test("moderation needs manager access and a hidden review reason is only visible in private views", async () => {
  const { review } = await created((await visit()).id);
  const staff = await actor(t, "staff", "staff@reviews.test");
  expect((await call("/admin/reviews", "GET", undefined, staff)).status).toBe(403);
  expect(
    (
      await call(
        `/admin/reviews/${review.id}/moderation`,
        "PUT",
        { version: 1, status: "published" },
        staff,
      )
    ).status,
  ).toBe(403);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, String(staff.staffId)));
  const hidden = await call(
    `/admin/reviews/${review.id}/moderation`,
    "PUT",
    { version: 1, status: "hidden", reason: "Contains a private phone number" },
    staff,
  );
  expect(hidden.status).toBe(200);
  expect(await hidden.json()).toMatchObject({
    status: "hidden",
    moderationReason: "Contains a private phone number",
  });
  const self = await call("/me/reviews");
  expect(await self.json()).toMatchObject({
    visits: [{ review: { moderationReason: "Contains a private phone number" } }],
  });
  const audits = await t.db.select().from(auditLog).where(eq(auditLog.entity, "review"));
  expect(JSON.stringify(audits)).not.toContain("phone number");
  expect(JSON.stringify(audits)).not.toContain("lovely completed");
});
test("outcome corrections remove public reviews and aggregates immediately; pagination stays bounded", async () => {
  const a = await visit();
  const one = await created(a.id);
  await publish(one.review);
  const two = await created((await visit()).id);
  await publish(two.review);
  const first = publicReviewsSchema.parse(
    await (await json(t.app, "/reviews?limit=1", "GET")).json(),
  );
  expect(first.reviews).toHaveLength(1);
  expect(first.nextBefore).toBe(first.reviews[0]?.id ?? null);
  const next = publicReviewsSchema.parse(
    await (await json(t.app, `/reviews?limit=1&before=${first.nextBefore}`, "GET")).json(),
  );
  expect(next.reviews).toHaveLength(1);
  expect(next.reviews[0]?.id).not.toBe(first.reviews[0]?.id);
  await t.db.update(appointment).set({ status: "no_show" }).where(eq(appointment.id, a.id));
  expect(await (await json(t.app, "/reviews", "GET")).json()).toMatchObject({ total: 1 });
  expect((await json(t.app, "/reviews?limit=10000", "GET")).status).toBe(400);
});

test("the original appointment, subject, snapshot and receipt cannot be reattributed in SQL", async () => {
  const original = await created((await visit()).id);
  const second = await visit();
  for (const change of [
    { appointmentId: second.id },
    { clientId: f.clientId },
    { services: [{ id: null, name: "Rewritten" }] },
    { requestFingerprint: "0".repeat(64) },
  ]) {
    let rejected = false;
    try {
      await t.db.update(review).set(change).where(eq(review.id, original.review.id));
    } catch (error) {
      rejected = true;
      expect(pgErrorCode(error)).toBe("23514");
    }
    expect(rejected).toBe(true);
  }
  const response = await call(
    `/admin/reviews/${original.review.id}/moderation`,
    "PUT",
    { version: 1, status: "hidden" },
    owner,
  );
  expect(response.status).toBe(400);
  await call(`/me/reviews/${original.review.id}/withdraw`, "POST", { version: 1 });
  expect(
    (
      await call(
        `/admin/reviews/${original.review.id}/moderation`,
        "PUT",
        { version: 2, status: "published" },
        owner,
      )
    ).status,
  ).toBe(409);
});

test("a queued moderator loses write access if demoted before acquiring the review lock", async () => {
  const original = await created((await visit()).id);
  const staff = await actor(t, "staff", "queued@reviews.test");
  if (!staff.staffId) throw new Error("Missing staff");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, staff.staffId));
  const principal = await loadPrincipal(t.db, staff.userId);
  if (!principal) throw new Error("Missing principal");
  let release = () => {};
  let ready = () => {};
  let writer: Tx | undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configuration = t.db.transaction(async (tx) => {
    writer = tx;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob-reviews-v1',0))`);
    ready();
    await resume;
  });
  await held;
  const pending = changeReview(
    t.db,
    original.review.id,
    { kind: "moderate", input: { version: 1, status: "published" } },
    principal,
    NOW,
  ).then(
    () => null,
    (error) => error,
  );
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    if (!writer) throw new Error("Missing writer");
    await writer
      .update(staffProfile)
      .set({ accessPreset: "professional" })
      .where(eq(staffProfile.id, staff.staffId));
  } finally {
    release();
    await configuration;
  }
  expect(await pending).toMatchObject({ code: "forbidden" });
  expect(await (await call("/admin/reviews", "GET", undefined, owner)).json()).toMatchObject({
    reviews: [{ status: "pending", version: 1 }],
  });
});

test("only explicitly consented, currently published completed-visit reviews can supply social creative", async () => {
  const ordinary = await created((await visit()).id);
  await publish(ordinary.review);
  expect(
    (await call(`/admin/reviews/${ordinary.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
  expect(
    (
      await call(
        `/admin/reviews/${ordinary.review.id}/moderation`,
        "PUT",
        { version: 2, status: "published", allowSocialUse: true },
        owner,
      )
    ).status,
  ).toBe(400);
  const allowed = await created((await visit()).id, { allowSocialUse: true });
  expect(
    (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
  const current = await publish(allowed.review);
  const response = await call(
    `/admin/reviews/${allowed.review.id}/social`,
    "GET",
    undefined,
    owner,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const content = await response.json();
  expect(content).toMatchObject({
    publicName: "A.",
    body: "A lovely completed visit.",
    rating: 5,
    services: [],
    permissionVersion: "public-review-social-v1",
  });
  expect(JSON.stringify(content)).not.toContain(customer.clientId ?? "missing");
  for (const who of [customer, await actor(t, "staff", "creative-staff@reviews.test")])
    expect(
      (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, who)).status,
    ).toBe(403);
  const { appointmentId: _visit, idempotencyKey: _key, ...wording } = allowed.input;
  const edited = await call(`/me/reviews/${allowed.review.id}`, "PUT", {
    ...wording,
    version: current.version,
    allowSocialUse: false,
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ status: "pending", allowSocialUse: false });
  expect(
    (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
  const repeated = await call("/me/reviews", "POST", { ...allowed.input, allowSocialUse: false });
  expect(repeated.status).toBe(409);
});

test("social reuse stops immediately after an outcome correction or withdrawal", async () => {
  const a = await visit();
  const allowed = await created(a.id, { allowSocialUse: true });
  const published = await publish(allowed.review);
  await t.db.update(appointment).set({ status: "no_show" }).where(eq(appointment.id, a.id));
  expect(
    (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
  const withdrawn = await call(`/me/reviews/${allowed.review.id}/withdraw`, "POST", {
    version: published.version,
  });
  expect(await withdrawn.json()).toMatchObject({ status: "withdrawn", allowSocialUse: false });
  expect(
    (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
});

test("a client can revoke social reuse without unpublishing their website feedback", async () => {
  const allowed = await created((await visit()).id, { allowSocialUse: true });
  const current = await publish(allowed.review);
  const revoked = await call(`/me/reviews/${allowed.review.id}/revoke-social`, "POST", {
    version: current.version,
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({
    status: "published",
    allowSocialUse: false,
    socialPermissionVersion: null,
    body: "A lovely completed visit.",
  });
  expect(await (await json(t.app, "/reviews", "GET")).json()).toMatchObject({ total: 1 });
  expect(
    (await call(`/admin/reviews/${allowed.review.id}/social`, "GET", undefined, owner)).status,
  ).toBe(404);
});

test("website-only review retries preserve the original receipt fingerprint across the social-permission upgrade", async () => {
  const { input, review: createdReview } = await created((await visit()).id);
  const legacy = createHash("sha256")
    .update(
      JSON.stringify([
        input.appointmentId,
        input.publicName,
        input.rating,
        input.body,
        input.shareServices,
        "public-appointment-review-v1",
      ]),
    )
    .digest("hex");
  const [stored] = await t.db.select().from(review).where(eq(review.id, createdReview.id));
  expect(stored?.requestFingerprint).toBe(legacy);
  expect((await call("/me/reviews", "POST", input)).status).toBe(201);
});
