import { createHash } from "node:crypto";
import {
  CLIENT_PHOTO_PER_CLIENT_LIMIT,
  CLIENT_PHOTO_PERMISSION_VERSION,
  CLIENT_PHOTO_SALON_LIMIT,
  type ClientPhoto,
  type ClientPhotoUpdate,
  type ClientPhotoUpload,
  permissionsFor,
} from "@sob/contracts";
import { clientPhoto, type Database } from "@sob/db";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientRoot, lockClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { normalizeClientPhoto } from "./photo-image";

const fields = {
  id: clientPhoto.id,
  clientId: clientPhoto.clientId,
  caption: clientPhoto.caption,
  capturedOn: clientPhoto.capturedOn,
  width: clientPhoto.width,
  height: clientPhoto.height,
  bytes: clientPhoto.bytes,
  version: clientPhoto.version,
  createdAt: clientPhoto.createdAt,
  updatedAt: clientPhoto.updatedAt,
};
const view = (
  row: { createdAt: Date; updatedAt: Date } & Omit<ClientPhoto, "createdAt" | "updatedAt">,
): ClientPhoto => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
const activeClient = clientRoot;
async function lockPhotos(tx: Tx, clientId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('sob-client-photo-capacity-v1',0))`,
  );
  return lockClientRoot(tx, clientId);
}
async function replay(
  db: Database | Tx,
  clientId: string,
  input: ClientPhotoUpload,
  p: Principal,
  fingerprint: string,
) {
  const [row] = await db
    .select({
      ...fields,
      deletedAt: clientPhoto.deletedAt,
      requestFingerprint: clientPhoto.requestFingerprint,
    })
    .from(clientPhoto)
    .where(
      and(
        eq(clientPhoto.createdBy, p.userId),
        eq(clientPhoto.idempotencyKey, input.idempotencyKey),
      ),
    );
  if (!row) return null;
  if (row.clientId !== clientId || row.requestFingerprint !== fingerprint || row.deletedAt)
    throw new DomainError("invalid_state", "This upload identifier was already used or removed");
  const { deletedAt: _, requestFingerprint: __, ...photo } = row;
  return view(photo);
}
export async function listClientPhotos(db: Database, id: string, p: Principal) {
  requirePermission(p, "clients");
  await activeClient(db, id);
  const rows = await db
    .select(fields)
    .from(clientPhoto)
    .where(
      and(
        sql`${clientPhoto.clientId} in(select client_identity_ids(${id}::uuid))`,
        isNull(clientPhoto.deletedAt),
      ),
    )
    .orderBy(desc(clientPhoto.createdAt), desc(clientPhoto.id));
  return {
    photos: rows.map(view),
    limit: CLIENT_PHOTO_PER_CLIENT_LIMIT,
    canEdit: permissionsFor(p.role, p.accessPreset).editClients,
  };
}
export async function uploadClientPhoto(
  db: Database,
  id: string,
  input: ClientPhotoUpload,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editClients");
  await activeClient(db, id);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([id, input.caption, input.capturedOn ?? null]))
    .update(Buffer.from(input.imageBase64, "base64"))
    .digest("hex");
  const previous = await replay(db, id, input, p, fingerprint);
  if (previous) return previous;
  const image = await normalizeClientPhoto(input.imageBase64);
  return db.transaction(async (tx) => {
    const root = await lockPhotos(tx, id);
    const previous = await replay(tx, id, input, p, fingerprint);
    if (previous) return previous;
    if (root.id !== id)
      throw new DomainError("client_merged", "Open the surviving profile before uploading a photo");
    const [total] = await tx
      .select({ count: count() })
      .from(clientPhoto)
      .where(isNull(clientPhoto.deletedAt));
    const [clientTotal] = await tx
      .select({ count: count() })
      .from(clientPhoto)
      .where(
        and(
          sql`${clientPhoto.clientId} in(select client_identity_ids(${id}::uuid))`,
          isNull(clientPhoto.deletedAt),
        ),
      );
    if (
      (total?.count ?? 0) >= CLIENT_PHOTO_SALON_LIMIT ||
      (clientTotal?.count ?? 0) >= CLIENT_PHOTO_PER_CLIENT_LIMIT
    )
      throw new DomainError(
        "storage_limit",
        "The private photo capacity has been reached; remove unused photos before adding another",
      );
    const [photo] = await tx
      .insert(clientPhoto)
      .values({
        clientId: id,
        caption: input.caption,
        capturedOn: input.capturedOn,
        ...image,
        permissionVersion: CLIENT_PHOTO_PERMISSION_VERSION,
        createdBy: p.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        createdAt: now,
        updatedAt: now,
      })
      .returning(fields);
    if (!photo) throw new Error("Photo insert failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "client.photo_uploaded",
      entity: "client_photo",
      entityId: photo.id,
      metadata: {
        clientId: id,
        permissionVersion: CLIENT_PHOTO_PERMISSION_VERSION,
        bytes: image.bytes,
      },
    });
    return view(photo);
  });
}
async function photoRow(tx: Tx, clientId: string, id: string) {
  const [row] = await tx
    .select({ ...fields, deletedAt: clientPhoto.deletedAt })
    .from(clientPhoto)
    .where(
      and(
        eq(clientPhoto.id, id),
        sql`${clientPhoto.clientId} in(select client_identity_ids(${clientId}::uuid))`,
      ),
    )
    .for("update");
  if (!row) throw new DomainError("not_found", "Photo not found");
  return row;
}
export async function updateClientPhoto(
  db: Database,
  clientId: string,
  id: string,
  input: ClientPhotoUpdate,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editClients");
  return db.transaction(async (tx) => {
    await lockPhotos(tx, clientId);
    const current = await photoRow(tx, clientId, id);
    if (current.deletedAt) throw new DomainError("not_found", "Photo not found");
    if (current.version !== input.version)
      throw new DomainError("version_conflict", "Photo details changed; reload before saving");
    const [saved] = await tx
      .update(clientPhoto)
      .set({
        caption: input.caption,
        capturedOn: input.capturedOn,
        version: current.version + 1,
        updatedAt: now,
      })
      .where(eq(clientPhoto.id, id))
      .returning(fields);
    if (!saved) throw new Error("Photo update failed");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "client.photo_updated",
      entity: "client_photo",
      entityId: id,
      metadata: { clientId, version: saved.version },
    });
    return view(saved);
  });
}
export async function deleteClientPhoto(
  db: Database,
  clientId: string,
  id: string,
  version: number,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editClients");
  return db.transaction(async (tx) => {
    await lockPhotos(tx, clientId);
    const current = await photoRow(tx, clientId, id);
    if (current.deletedAt && current.version === version + 1) return { id, deleted: true as const };
    if (current.deletedAt) throw new DomainError("not_found", "Photo not found");
    if (current.version !== version)
      throw new DomainError("version_conflict", "Photo details changed; reload before removing");
    await tx
      .update(clientPhoto)
      .set({
        image: null,
        caption: "Removed private photo",
        capturedOn: null,
        deletedAt: now,
        updatedAt: now,
        version: current.version + 1,
      })
      .where(eq(clientPhoto.id, id));
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "client.photo_removed",
      entity: "client_photo",
      entityId: id,
      metadata: { clientId },
    });
    return { id, deleted: true as const };
  });
}
export async function readClientPhotoImage(
  db: Database,
  clientId: string,
  id: string,
  p: Principal,
) {
  requirePermission(p, "clients");
  await activeClient(db, clientId);
  const [row] = await db
    .select({ image: clientPhoto.image })
    .from(clientPhoto)
    .where(
      and(
        eq(clientPhoto.id, id),
        sql`${clientPhoto.clientId} in(select client_identity_ids(${clientId}::uuid))`,
        isNull(clientPhoto.deletedAt),
      ),
    );
  if (!row?.image) throw new DomainError("not_found", "Photo not found");
  return row.image;
}
