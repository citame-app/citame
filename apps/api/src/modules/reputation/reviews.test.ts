import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { publicReviewsSchema, reviewPrivateSchema } from "@sob/contracts";
import {
  appointment,
  appointmentService,
  auditLog,
  pgErrorCode,
  review,
  service,
  staffProfile,
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
import type { Tx } from "../../tx";
import { changeReview } from "./reviews";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let customer: Actor;
let owner: Actor;
let day = 0;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "reputation_reviews" });
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
