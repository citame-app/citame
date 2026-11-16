import { createHash } from "node:crypto";
import {
  CLIENT_IDENTITY_MAX_PROFILES,
  CLIENT_PHOTO_PER_CLIENT_LIMIT,
  type ClientMergeInput,
  type ClientMergePair,
  type ClientMergePreview,
  clientTagsSchema,
} from "@sob/contracts";
import {
  appointment,
  checkout,
  clientMerge,
  clientPhoto,
  clientProfile,
  type Database,
  giftCard,
  intakeSubmission,
  passContract,
} from "@sob/db";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { clientIdentityIds } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type Connection = Database | Tx;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function live(tx: Connection, p: Principal) {
  const current = await loadPrincipal(tx, p.userId);
  if (!current) throw new DomainError("forbidden", "Account no longer available");
  requirePermission(current, "deleteClients");
  return current;
}
async function prepare(db: Connection, input: ClientMergePair) {
  const rows = await db
    .select()
    .from(clientProfile)
    .where(inArray(clientProfile.id, [input.sourceId, input.targetId]));
  const source = rows.find((row) => row.id === input.sourceId),
    target = rows.find((row) => row.id === input.targetId);
  if (!source || !target || source.deletedAt || target.deletedAt)
    throw new DomainError("not_found", "Current client profiles not found");
  const sourceIds = await clientIdentityIds(db, source.id),
    targetIds = await clientIdentityIds(db, target.id);
  const ids = [...new Set([...sourceIds, ...targetIds])].sort();
  const tags = clientTagsSchema.safeParse([
    ...new Set(
      [...target.tags, ...source.tags].map((tag) => tag.normalize("NFKC").trim().toLowerCase()),
    ),
  ]);
  const [appts, bills, photos, forms, passes, gifts] = await Promise.all([
    db.select({ value: count() }).from(appointment).where(inArray(appointment.clientId, ids)),
    db.select({ value: count() }).from(checkout).where(inArray(checkout.clientId, ids)),
    db
      .select({ value: count() })
      .from(clientPhoto)
      .where(and(inArray(clientPhoto.clientId, ids), sql`${clientPhoto.deletedAt} is null`)),
    db
      .select({ value: count() })
      .from(intakeSubmission)
      .where(inArray(intakeSubmission.clientId, ids)),
    db.select({ value: count() }).from(passContract).where(inArray(passContract.clientId, ids)),
    db.select({ value: count() }).from(giftCard).where(inArray(giftCard.buyerClientId, ids)),
  ]);
  const counts = {
    profiles: ids.length,
    appointments: appts[0]?.value ?? 0,
    receipts: bills[0]?.value ?? 0,
    photos: photos[0]?.value ?? 0,
    forms: forms[0]?.value ?? 0,
    passes: passes[0]?.value ?? 0,
    gifts: gifts[0]?.value ?? 0,
  };
  const reasons: ClientMergePreview["reasons"] = [];
  if (source.userId) reasons.push("source_account");
  if (source.mergedIntoId) reasons.push("source_merged");
  if (target.mergedIntoId) reasons.push("target_merged");
  if (ids.length > CLIENT_IDENTITY_MAX_PROFILES) reasons.push("group_limit");
  if (counts.photos > CLIENT_PHOTO_PER_CLIENT_LIMIT) reasons.push("photo_limit");
  if (!tags.success) reasons.push("tag_limit");
  const view = (row: typeof clientProfile.$inferSelect, profileCount: number) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    tags: row.tags,
    bookingAccess: row.bookingAccess as "normal" | "trusted" | "blocked",
    hasAccount: Boolean(row.userId),
    profileCount,
  });
  const reviewHash = hash({
    source,
    target,
    sourceIds: [...sourceIds].sort(),
    targetIds: [...targetIds].sort(),
    counts,
  });
  return {
    source,
    target,
    tags: tags.success ? tags.data : [],
    preview: {
      reviewHash,
      canMerge: reasons.length === 0,
      reasons,
      source: view(source, sourceIds.length),
      target: view(target, targetIds.length),
      counts,
    } satisfies ClientMergePreview,
  };
}
export async function previewClientMerge(db: Database, input: ClientMergePair, p: Principal) {
  requirePermission(p, "deleteClients");
  return db.transaction(
    async (tx) => {
      await live(tx, p);
      return (await prepare(tx, input)).preview;
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
const receipt = (row: typeof clientMerge.$inferSelect) => ({
  id: row.id,
  sourceId: row.sourceId,
  targetId: row.targetId,
  createdAt: row.createdAt.toISOString(),
});
export async function mergeClients(db: Database, input: ClientMergeInput, p: Principal, now: Date) {
  requirePermission(p, "deleteClients");
  const fingerprint = hash({
    sourceId: input.sourceId,
    targetId: input.targetId,
    confirmedSamePerson: input.confirmedSamePerson,
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('sob-client-identity-links-v1',0))`,
    );
    const actor = await live(tx, p);
    const [previous] = await tx
      .select()
      .from(clientMerge)
      .where(
        and(
          eq(clientMerge.createdBy, actor.userId),
          eq(clientMerge.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestFingerprint !== fingerprint)
        throw new DomainError(
          "invalid_state",
          "This merge identifier belongs to another reviewed pair",
        );
      return receipt(previous);
    }
    await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(inArray(clientProfile.id, [input.sourceId, input.targetId]))
      .orderBy(asc(clientProfile.id))
      .for("update");
    await live(tx, p);
    const { source, target, tags, preview } = await prepare(tx, input);
    if (preview.reviewHash !== input.reviewHash)
      throw new DomainError(
        "version_conflict",
        "The profiles changed; review this identity link again",
      );
    if (!preview.canMerge)
      throw new DomainError(
        "invalid_state",
        "These profiles cannot be linked; review the current restrictions",
      );
    const [saved] = await tx
      .insert(clientMerge)
      .values({
        sourceId: source.id,
        targetId: target.id,
        createdBy: actor.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        reviewHash: input.reviewHash,
        createdAt: now,
      })
      .returning();
    if (!saved) throw new Error("Merge receipt missing");
    await tx
      .update(clientProfile)
      .set({ mergedIntoId: target.id, controlsVersion: source.controlsVersion + 1 })
      .where(eq(clientProfile.id, source.id));
    const blocked = source.bookingAccess === "blocked" || target.bookingAccess === "blocked";
    await tx
      .update(clientProfile)
      .set({
        tags,
        bookingAccess: blocked
          ? "blocked"
          : source.bookingAccess === "trusted" && target.bookingAccess === "trusted"
            ? "trusted"
            : "normal",
        bookingAccessReason: blocked
          ? target.bookingAccess === "blocked"
            ? target.bookingAccessReason
            : source.bookingAccessReason
          : target.bookingAccessReason,
        controlsVersion: target.controlsVersion + 1,
      })
      .where(eq(clientProfile.id, target.id));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "client.merge",
      entity: "client_merge",
      entityId: saved.id,
      metadata: { sourceId: source.id, targetId: target.id, profiles: preview.counts.profiles },
    });
    return receipt(saved);
  });
}
