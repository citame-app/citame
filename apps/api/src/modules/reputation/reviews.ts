import { createHash } from "node:crypto";
import {
  REVIEW_SOCIAL_PERMISSION_VERSION,
  type ReviewCreate,
  type ReviewEdit,
  type ReviewModeration,
  type ReviewPrivate,
  type reviewAdminQuerySchema,
  type reviewPrivateQuerySchema,
  type reviewPublicQuerySchema,
  reviewPublicSchema,
  type reviewRequestQuerySchema,
  reviewServicesSchema,
  reviewSocialSchema,
} from "@sob/contracts";
import {
  appointment,
  appointmentService,
  clientProfile,
  type Database,
  marketingDelivery,
  review,
} from "@sob/db";
import {
  and,
  asc,
  avg,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, ownedClientIds, ownsClient, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { commercialPermissionSql } from "../marketing/consent";

const PERMISSION = "public-appointment-review-v1";
type Connection = Database | Tx;
type Row = typeof review.$inferSelect;
type Visit = typeof appointment.$inferSelect;
function ownClient(p: Principal) {
  if (p.role !== "client" || !p.clientId)
    throw new DomainError("forbidden", "Only client accounts can review their visits");
  return p.clientId;
}
async function lockReviews(tx: Tx, p: Principal) {
  // Separate from scheduling: no booking path takes this lock or a review row lock.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob-reviews-v1',0))`);
  const current = await loadPrincipal(tx, p.userId);
  if (!current) throw new DomainError("forbidden", "This account is no longer available");
  return current;
}
function eligible(a: Visit, now: Date) {
  return a.status === "completed" && !a.deletedAt && a.endsAt <= now;
}
const eligibleSql = (now: Date) =>
  and(
    eq(appointment.status, "completed"),
    isNull(appointment.deletedAt),
    lte(appointment.endsAt, now),
    isNull(clientProfile.deletedAt),
    sql`exists(select 1 from client_profile survivor where survivor.id=client_root_id(${clientProfile.id}) and survivor.deleted_at is null)`,
  );
async function snapshot(db: Connection, ids: string[]) {
  if (!ids.length) return new Map<string, { id: string | null; name: string }[]>();
  const rows = await db
    .select()
    .from(appointmentService)
    .where(inArray(appointmentService.appointmentId, ids))
    .orderBy(asc(appointmentService.position), asc(appointmentService.id));
  const result = new Map<string, { id: string | null; name: string }[]>();
  for (const row of rows) {
    const values = result.get(row.appointmentId) ?? [];
    values.push({ id: row.serviceId, name: row.name });
    result.set(row.appointmentId, values);
  }
  return result;
}
function privateView(row: Row, a: Visit, now: Date): ReviewPrivate {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    publicName: row.publicName,
    body: row.body,
    rating: row.rating,
    shareServices: row.shareServices,
    allowSocialUse: row.allowSocialUse,
    socialPermissionVersion:
      row.socialPermissionVersion === REVIEW_SOCIAL_PERMISSION_VERSION
        ? REVIEW_SOCIAL_PERMISSION_VERSION
        : null,
    services: reviewServicesSchema.parse(row.services),
    status: row.status as ReviewPrivate["status"],
    moderationReason: row.moderationReason,
    reply: row.reply,
    version: row.version,
    sourceEligible: eligible(a, now),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
async function audit(tx: Tx, p: Principal, row: Row, action: string) {
  await recordAudit(tx, {
    actorUserId: p.userId,
    action: `review.${action}`,
    entity: "review",
    entityId: row.id,
    metadata: {
      version: row.version,
      status: row.status,
      allowSocialUse: row.allowSocialUse,
      socialPermissionVersion: row.socialPermissionVersion,
    },
  });
}
export async function createReview(db: Database, input: ReviewCreate, p: Principal, now: Date) {
  ownClient(p);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        input.appointmentId,
        input.publicName,
        input.rating,
        input.body,
        input.shareServices,
        PERMISSION,
        ...(input.allowSocialUse ? [REVIEW_SOCIAL_PERMISSION_VERSION] : []),
      ]),
    )
    .digest("hex");
  return db.transaction(async (tx) => {
    const current = await lockReviews(tx, p);
    ownClient(current);
    const [previous] = await tx
      .select()
      .from(review)
      .where(and(eq(review.createdBy, p.userId), eq(review.idempotencyKey, input.idempotencyKey)));
    if (previous) {
      if (!ownsClient(current, previous.clientId) || previous.requestFingerprint !== fingerprint)
        throw new DomainError(
          "invalid_state",
          "This review identifier already belongs to another submission",
        );
      const [a] = await tx
        .select()
        .from(appointment)
        .where(eq(appointment.id, previous.appointmentId));
      if (!a) throw new DomainError("not_found", "Appointment not found");
      return privateView(previous, a, now);
    }
    const [a] = await tx
      .select()
      .from(appointment)
      .where(
        and(
          eq(appointment.id, input.appointmentId),
          inArray(appointment.clientId, ownedClientIds(current)),
        ),
      )
      .for("update");
    if (!a) throw new DomainError("not_found", "Appointment not found");
    if (!eligible(a, now))
      throw new DomainError(
        "invalid_state",
        "Only completed, elapsed appointments can be reviewed",
      );
    const [existing] = await tx
      .select({ id: review.id })
      .from(review)
      .where(eq(review.appointmentId, a.id));
    if (existing)
      throw new DomainError(
        "invalid_state",
        "This visit already has a review; edit the existing review instead",
      );
    const [total] = await tx.select({ total: count() }).from(review);
    if ((total?.total ?? 0) >= 50000)
      throw new DomainError("storage_limit", "Review storage capacity has been reached");
    const [row] = await tx
      .insert(review)
      .values({
        appointmentId: a.id,
        clientId: a.clientId,
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        publicName: input.publicName,
        body: input.body,
        rating: input.rating,
        shareServices: input.shareServices,
        allowSocialUse: input.allowSocialUse,
        socialPermissionVersion: input.allowSocialUse ? REVIEW_SOCIAL_PERMISSION_VERSION : null,
        services: (await snapshot(tx, [a.id])).get(a.id) ?? [],
        publicationVersion: PERMISSION,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) throw new Error("Review insert returned no row");
    await audit(tx, p, row, "create");
    return privateView(row, a, now);
  });
}
type Change =
  | { kind: "edit"; input: ReviewEdit }
  | { kind: "withdraw"; input: { version: number } }
  | { kind: "revokeSocial"; input: { version: number } }
  | { kind: "moderate"; input: ReviewModeration }
  | { kind: "reply"; input: { version: number; reply: string | null } };
export async function changeReview(
  db: Database,
  id: string,
  change: Change,
  p: Principal,
  now: Date,
) {
  const team = change.kind === "moderate" || change.kind === "reply";
  if (team) requirePermission(p, "editCatalog");
  else ownClient(p);
  return db.transaction(async (tx) => {
    const current = await lockReviews(tx, p);
    if (team) requirePermission(current, "editCatalog");
    else ownClient(current);
    const [row] = await tx
      .select()
      .from(review)
      .where(
        and(
          eq(review.id, id),
          team ? undefined : inArray(review.clientId, ownedClientIds(current)),
        ),
      )
      .for("update");
    if (!row) throw new DomainError("not_found", "Review not found");
    const [a] = await tx
      .select()
      .from(appointment)
      .where(eq(appointment.id, row.appointmentId))
      .for("update");
    if (!a) throw new DomainError("not_found", "Appointment not found");
    if (change.input.version !== row.version)
      throw new DomainError(
        "version_conflict",
        "This review changed; reload before reviewing your changes",
      );
    let changes: Partial<typeof review.$inferInsert>;
    switch (change.kind) {
      case "edit":
        if (!eligible(a, now))
          throw new DomainError(
            "invalid_state",
            "This appointment is no longer eligible for a review",
          );
        changes = {
          publicName: change.input.publicName,
          rating: change.input.rating,
          body: change.input.body,
          shareServices: change.input.shareServices,
          allowSocialUse: change.input.allowSocialUse,
          socialPermissionVersion: change.input.allowSocialUse
            ? REVIEW_SOCIAL_PERMISSION_VERSION
            : null,
          publicationVersion: PERMISSION,
          status: "pending",
          reply: null,
          moderationReason: null,
          publishedAt: null,
        };
        break;
      case "withdraw":
        changes = {
          publicName: null,
          rating: null,
          body: null,
          shareServices: false,
          allowSocialUse: false,
          socialPermissionVersion: null,
          status: "withdrawn",
          reply: null,
          moderationReason: null,
          publishedAt: null,
        };
        break;
      case "revokeSocial":
        changes = { allowSocialUse: false, socialPermissionVersion: null };
        break;
      case "moderate":
        if (row.status === "withdrawn")
          throw new DomainError(
            "invalid_state",
            "A withdrawn review cannot be published by the team",
          );
        if (change.input.status === "published" && !eligible(a, now))
          throw new DomainError(
            "invalid_state",
            "This appointment is no longer eligible for a public review",
          );
        changes = {
          status: change.input.status,
          moderationReason: change.input.status === "hidden" ? change.input.reason : null,
          publishedAt: change.input.status === "published" ? now : null,
        };
        break;
      case "reply":
        if (row.status !== "published" || !eligible(a, now))
          throw new DomainError(
            "invalid_state",
            "Only a currently published review can receive a public reply",
          );
        changes = { reply: change.input.reply };
    }
    const [updated] = await tx
      .update(review)
      .set({ ...changes, version: row.version + 1, updatedAt: now })
      .where(eq(review.id, id))
      .returning();
    if (!updated) throw new Error("Review update returned no row");
    await audit(tx, p, updated, change.kind);
    return privateView(updated, a, now);
  });
}
export async function ownReviews(
  db: Database,
  p: Principal,
  query: z.infer<typeof reviewPrivateQuerySchema>,
  now: Date,
) {
  ownClient(p);
  const rows = await db
    .select({ a: appointment, r: review })
    .from(appointment)
    .leftJoin(review, eq(review.appointmentId, appointment.id))
    .where(
      and(
        inArray(appointment.clientId, ownedClientIds(p)),
        query.appointmentId ? eq(appointment.id, query.appointmentId) : undefined,
        query.before ? lt(appointment.id, query.before) : undefined,
        or(
          and(
            eq(appointment.status, "completed"),
            isNull(appointment.deletedAt),
            lte(appointment.endsAt, now),
          ),
          sql`${review.id} is not null`,
        ),
      ),
    )
    .orderBy(desc(appointment.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const services = await snapshot(
    db,
    page.map((row) => row.a.id),
  );
  return {
    visits: page.map(({ a, r }) => ({
      appointmentId: a.id,
      startsAt: a.startsAt.toISOString(),
      services: services.get(a.id) ?? [],
      review: r ? privateView(r, a, now) : null,
    })),
    nextBefore: rows.length > query.limit ? (page.at(-1)?.a.id ?? null) : null,
  };
}

const requestClient = alias(clientProfile, "review_request_client");

function reviewAccount(requireVerification: boolean, matchEmail = false) {
  return sql<boolean>`exists (
    select 1 from client_profile candidate
    join "user" account on account.id = candidate.user_id and account.role = 'client'
    where candidate.deleted_at is null
      and (${!requireVerification} or account.email_verified)
      and candidate.id in (select client_identity_ids(${requestClient.id}))
      ${matchEmail ? sql`and lower(trim(account.email)) = lower(trim(${requestClient.email}))` : sql``}
  )`;
}

const canEmailReview = () =>
  sql<boolean>`${reviewAccount(true, true)} and ${commercialPermissionSql(requestClient.id, "email")}`;

function reviewRequestVisits(db: Connection, canShare = sql<boolean>`false`) {
  return db
    .select({
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      clientId: requestClient.id,
      clientName: requestClient.name,
      email: requestClient.email,
      locale: requestClient.locale,
      canShare,
      canEmail: canEmailReview(),
      emailStatus: marketingDelivery.status,
    })
    .from(appointment)
    .innerJoin(clientProfile, eq(clientProfile.id, appointment.clientId))
    .innerJoin(requestClient, eq(requestClient.id, sql`client_root_id(${clientProfile.id})`))
    .leftJoin(review, eq(review.appointmentId, appointment.id))
    .leftJoin(marketingDelivery, eq(marketingDelivery.reviewAppointmentId, appointment.id));
}

export async function reviewEmailTarget(db: Connection, appointmentId: string, now: Date) {
  const [row] = await reviewRequestVisits(db).where(
    and(eq(appointment.id, appointmentId), eligibleSql(now), isNull(review.id), canEmailReview()),
  );
  return row;
}

export function reviewRequestLink(origin: string, appointmentId: string) {
  const link = new URL("/account/reviews", origin);
  link.searchParams.set("appointmentId", appointmentId);
  return link.href;
}

export async function reviewRequests(
  db: Database,
  p: Principal,
  query: z.infer<typeof reviewRequestQuerySchema>,
  now: Date,
  auth: { publicUrl: string; requireEmailVerification: boolean },
  emailEnabled: boolean,
) {
  requirePermission(p, "editCatalog");
  const limit = 20;
  const search = query.search.replace(/[\\%_]/g, (char) => `\\${char}`);
  const canShare = sql<boolean>`(${eligibleSql(now)} and ${isNull(review.id)} and ${reviewAccount(auth.requireEmailVerification)})`;
  const rows = await reviewRequestVisits(db, canShare)
    .where(
      and(
        isNull(clientProfile.deletedAt),
        isNull(requestClient.deletedAt),
        search ? ilike(requestClient.name, `%${search}%`) : undefined,
        or(canShare, sql`${marketingDelivery.id} is not null`),
      ),
    )
    .orderBy(desc(appointment.startsAt), desc(appointment.id))
    .limit(limit + 1)
    .offset((query.page - 1) * limit);
  return {
    visits: rows
      .slice(0, limit)
      .map(({ appointmentId, startsAt, clientName, canShare, canEmail, emailStatus }) => ({
        appointmentId,
        startsAt: startsAt.toISOString(),
        clientName,
        link: canShare ? reviewRequestLink(auth.publicUrl, appointmentId) : null,
        canEmail: canShare && emailEnabled && canEmail,
        emailStatus,
      })),
    hasMore: rows.length > limit,
    emailEnabled,
  };
}
export async function adminReviews(
  db: Database,
  p: Principal,
  query: z.infer<typeof reviewAdminQuerySchema>,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  const rows = await db
    .select({ r: review, a: appointment })
    .from(review)
    .innerJoin(appointment, eq(appointment.id, review.appointmentId))
    .where(
      and(
        query.status ? eq(review.status, query.status) : undefined,
        query.before ? lt(review.id, query.before) : undefined,
      ),
    )
    .orderBy(desc(review.id))
    .limit(query.limit + 1);
  return {
    reviews: rows.slice(0, query.limit).map(({ r, a }) => privateView(r, a, now)),
    nextBefore: rows.length > query.limit ? (rows[query.limit - 1]?.r.id ?? null) : null,
  };
}
export async function publicReviews(
  db: Database,
  query: z.infer<typeof reviewPublicQuerySchema>,
  now: Date,
) {
  // Snapshot JSON is decoded by Drizzle; filter via the immutable appointment-service relation
  // instead of JSON operators (the Bun driver may encode JSON as a string).
  const filter = and(
    eq(review.status, "published"),
    eligibleSql(now),
    query.serviceId
      ? and(
          eq(review.shareServices, true),
          sql`exists(select 1 from ${appointmentService} where ${appointmentService.appointmentId}=${review.appointmentId} and ${appointmentService.serviceId}=${query.serviceId})`,
        )
      : undefined,
  );
  return db.transaction(async (tx) => {
    // Page and aggregate must describe the same publication snapshot.
    await tx.execute(sql`set transaction isolation level repeatable read read only`);
    const [summary] = await tx
      .select({ total: count(), average: avg(review.rating) })
      .from(review)
      .innerJoin(appointment, eq(appointment.id, review.appointmentId))
      .innerJoin(clientProfile, eq(clientProfile.id, review.clientId))
      .where(filter);
    const rows = await tx
      .select({ r: review })
      .from(review)
      .innerJoin(appointment, eq(appointment.id, review.appointmentId))
      .innerJoin(clientProfile, eq(clientProfile.id, review.clientId))
      .where(and(filter, query.before ? lt(review.id, query.before) : undefined))
      .orderBy(desc(review.id))
      .limit(query.limit + 1);
    return {
      reviews: rows.slice(0, query.limit).map(({ r }) =>
        reviewPublicSchema.parse({
          id: r.id,
          publicName: r.publicName,
          body: r.body,
          rating: r.rating,
          services: r.shareServices ? reviewServicesSchema.parse(r.services) : [],
          reply: r.reply,
          publishedAt: r.publishedAt?.toISOString(),
        }),
      ),
      total: summary?.total ?? 0,
      average: summary?.average ? Number(summary.average) : null,
      nextBefore: rows.length > query.limit ? (rows[query.limit - 1]?.r.id ?? null) : null,
    };
  });
}

export async function reviewForSocial(db: Database, id: string, p: Principal, now: Date) {
  requirePermission(p, "editCatalog");
  const [row] = await db
    .select({ r: review })
    .from(review)
    .innerJoin(appointment, eq(appointment.id, review.appointmentId))
    .innerJoin(clientProfile, eq(clientProfile.id, review.clientId))
    .where(
      and(
        eq(review.id, id),
        eq(review.status, "published"),
        eq(review.allowSocialUse, true),
        eq(review.socialPermissionVersion, REVIEW_SOCIAL_PERMISSION_VERSION),
        eligibleSql(now),
      ),
    );
  if (!row)
    throw new DomainError("not_found", "This review is not currently available for social reuse");
  const r = row.r;
  return reviewSocialSchema.parse({
    id: r.id,
    publicName: r.publicName,
    rating: r.rating,
    body: r.body,
    services: r.shareServices ? reviewServicesSchema.parse(r.services) : [],
    reply: r.reply,
    publishedAt: r.publishedAt?.toISOString(),
    permissionVersion: REVIEW_SOCIAL_PERMISSION_VERSION,
    reviewVersion: r.version,
  });
}
