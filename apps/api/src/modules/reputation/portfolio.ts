import { createHash } from "node:crypto";
import {
  PORTFOLIO_LIMIT,
  PORTFOLIO_PERMISSION_VERSION,
  type PortfolioEdit,
  type PortfolioUpload,
  portfolioAdminPhotoSchema,
  portfolioPublicPhotoSchema,
  type portfolioQuerySchema,
} from "@sob/contracts";
import { type Database, portfolioPhoto, service } from "@sob/db";
import { and, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import type { z } from "zod";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { normalizeClientPhoto } from "../clients/photo-image";

const fields = {
  id: portfolioPhoto.id,
  caption: portfolioPhoto.caption,
  alt: portfolioPhoto.alt,
  serviceId: portfolioPhoto.serviceId,
  serviceName: portfolioPhoto.serviceName,
  width: portfolioPhoto.width,
  height: portfolioPhoto.height,
  bytes: portfolioPhoto.bytes,
  status: portfolioPhoto.status,
  version: portfolioPhoto.version,
  publishedAt: portfolioPhoto.publishedAt,
  createdAt: portfolioPhoto.createdAt,
};
type Row = { createdAt: Date; publishedAt: Date | null } & Record<string, unknown>;
const adminView = (row: Row) =>
  portfolioAdminPhotoSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    publishedAt: row.publishedAt?.toISOString() ?? null,
  });
const publicView = (row: Row) =>
  portfolioPublicPhotoSchema.parse({ ...row, publishedAt: row.publishedAt?.toISOString() });
async function lockPortfolio(tx: Tx, p: Principal) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('sob-portfolio-v1',0))`);
  const live = await loadPrincipal(tx, p.userId);
  if (!live) throw new DomainError("forbidden", "This account is no longer available");
  requirePermission(live, "editCatalog");
}
async function serviceName(tx: Tx, id: string | null) {
  if (!id) return null;
  const [row] = await tx
    .select({ name: service.name })
    .from(service)
    .where(and(eq(service.id, id), eq(service.active, true), isNull(service.deletedAt)))
    .for("share");
  if (!row) throw new DomainError("validation_error", "Choose an active treatment or no treatment");
  return row.name;
}
async function replay(
  db: Database | Tx,
  input: PortfolioUpload,
  p: Principal,
  fingerprint: string,
) {
  const [row] = await db
    .select({
      ...fields,
      deletedAt: portfolioPhoto.deletedAt,
      requestFingerprint: portfolioPhoto.requestFingerprint,
    })
    .from(portfolioPhoto)
    .where(
      and(
        eq(portfolioPhoto.createdBy, p.userId),
        eq(portfolioPhoto.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (!row) return null;
  if (row.deletedAt || row.requestFingerprint !== fingerprint)
    throw new DomainError(
      "invalid_state",
      "This upload identifier has already been used or removed",
    );
  return adminView(row);
}
export async function uploadPortfolio(
  db: Database,
  input: PortfolioUpload,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.caption, input.alt, input.serviceId]))
    .update(Buffer.from(input.imageBase64, "base64"))
    .digest("hex");
  const previous = await replay(db, input, p, fingerprint);
  if (previous) return previous;
  const image = await normalizeClientPhoto(input.imageBase64);
  return db.transaction(async (tx) => {
    await lockPortfolio(tx, p);
    const previous = await replay(tx, input, p, fingerprint);
    if (previous) return previous;
    const [total] = await tx
      .select({ total: count() })
      .from(portfolioPhoto)
      .where(isNull(portfolioPhoto.deletedAt));
    if ((total?.total ?? 0) >= PORTFOLIO_LIMIT)
      throw new DomainError(
        "storage_limit",
        "Remove unused portfolio images before uploading another",
      );
    const name = await serviceName(tx, input.serviceId);
    const [row] = await tx
      .insert(portfolioPhoto)
      .values({
        caption: input.caption,
        alt: input.alt,
        serviceId: input.serviceId,
        serviceName: name,
        ...image,
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      })
      .returning(fields);
    if (!row) throw new Error("Portfolio insert returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "portfolio.upload",
      entity: "portfolio_photo",
      entityId: row.id,
      metadata: { bytes: row.bytes },
    });
    return adminView(row);
  });
}
type Change =
  | { kind: "edit"; input: PortfolioEdit }
  | { kind: "publish" | "unpublish" | "remove"; input: { version: number } };
export async function changePortfolio(
  db: Database,
  id: string,
  change: Change,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editCatalog");
  return db.transaction(async (tx) => {
    await lockPortfolio(tx, p);
    const [row] = await tx
      .select(fields)
      .from(portfolioPhoto)
      .where(and(eq(portfolioPhoto.id, id), isNull(portfolioPhoto.deletedAt)))
      .for("update");
    if (!row) throw new DomainError("not_found", "Portfolio photo not found");
    if (row.version !== change.input.version)
      throw new DomainError(
        "version_conflict",
        "This portfolio photo changed; reload and review its current content",
      );
    let changes: Partial<typeof portfolioPhoto.$inferInsert>;
    switch (change.kind) {
      case "edit":
        changes = {
          caption: change.input.caption,
          alt: change.input.alt,
          serviceId: change.input.serviceId,
          serviceName:
            change.input.serviceId === row.serviceId
              ? row.serviceName
              : await serviceName(tx, change.input.serviceId),
          status: "draft",
          publicationVersion: null,
          publishedAt: null,
        };
        break;
      case "publish":
        changes = {
          status: "published",
          publicationVersion: PORTFOLIO_PERMISSION_VERSION,
          publishedAt: now,
        };
        break;
      case "unpublish":
        changes = { status: "draft", publicationVersion: null, publishedAt: null };
        break;
      case "remove":
        changes = {
          status: "draft",
          image: null,
          caption: null,
          alt: null,
          serviceId: null,
          serviceName: null,
          publicationVersion: null,
          publishedAt: null,
          deletedAt: now,
        };
        break;
    }
    const [updated] = await tx
      .update(portfolioPhoto)
      .set({ ...changes, version: row.version + 1, updatedAt: now })
      .where(eq(portfolioPhoto.id, id))
      .returning(fields);
    if (!updated) throw new Error("Portfolio update returned no row");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: `portfolio.${change.kind}`,
      entity: "portfolio_photo",
      entityId: id,
      metadata: {
        version: updated.version,
        ...(change.kind === "publish" ? { publicationVersion: PORTFOLIO_PERMISSION_VERSION } : {}),
      },
    });
    return change.kind === "remove" ? { id, removed: true as const } : adminView(updated);
  });
}
export async function listPortfolioAdmin(db: Database, p: Principal) {
  requirePermission(p, "editCatalog");
  return {
    photos: (
      await db
        .select(fields)
        .from(portfolioPhoto)
        .where(isNull(portfolioPhoto.deletedAt))
        .orderBy(desc(portfolioPhoto.id))
        .limit(PORTFOLIO_LIMIT)
    ).map(adminView),
    limit: PORTFOLIO_LIMIT,
  };
}
export async function listPortfolioPublic(
  db: Database,
  query: z.infer<typeof portfolioQuerySchema>,
) {
  const rows = await db
    .select(fields)
    .from(portfolioPhoto)
    .where(
      and(
        eq(portfolioPhoto.status, "published"),
        isNull(portfolioPhoto.deletedAt),
        query.before ? lt(portfolioPhoto.id, query.before) : undefined,
        query.serviceId ? eq(portfolioPhoto.serviceId, query.serviceId) : undefined,
      ),
    )
    .orderBy(desc(portfolioPhoto.id))
    .limit(query.limit + 1);
  return {
    photos: rows.slice(0, query.limit).map(publicView),
    nextBefore: rows.length > query.limit ? (rows[query.limit - 1]?.id ?? null) : null,
  };
}
export async function portfolioImage(db: Database, id: string, p?: Principal) {
  if (p) requirePermission(p, "editCatalog");
  const [row] = await db
    .select({ image: portfolioPhoto.image })
    .from(portfolioPhoto)
    .where(
      and(
        eq(portfolioPhoto.id, id),
        isNull(portfolioPhoto.deletedAt),
        p ? undefined : eq(portfolioPhoto.status, "published"),
      ),
    );
  if (!row?.image) throw new DomainError("not_found", "Portfolio image not found");
  return new Response(new Uint8Array(row.image), {
    headers: {
      "content-type": "image/jpeg",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "content-length": String(row.image.byteLength),
    },
  });
}
