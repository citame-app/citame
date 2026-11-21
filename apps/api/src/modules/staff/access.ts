import {
  initialSyncGeneration,
  type ReviewedStaffAccessInput,
  type StaffAccessPreset,
} from "@sob/contracts";
import { type Database, staffProfile, user } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
export async function getReviewedStaffAccess(
  db: Database,
  staffId: string,
  principal: Principal,
  generation: string,
) {
  requireRole(principal, "owner");
  const [staff] = await db
    .select({
      accountId: staffProfile.userId,
      accountRole: user.role,
      accountEmail: user.email,
      version: staffProfile.accessVersion,
      preset: staffProfile.accessPreset,
    })
    .from(staffProfile)
    .leftJoin(user, eq(user.id, staffProfile.userId))
    .where(and(eq(staffProfile.id, staffId), isNull(staffProfile.deletedAt)));
  if (!staff) throw new DomainError("not_found", "Staff profile not found");
  return {
    generation,
    accountId: staff.accountId,
    accountEmail: staff.accountEmail,
    access: {
      staffId,
      preset: staff.preset,
      version: staff.version,
      accountRole: staff.accountRole,
    },
  };
}

export async function setStaffAccess(
  db: Database,
  staffId: string,
  input: { preset: StaffAccessPreset; version: number } | ReviewedStaffAccessInput,
  principal: Principal,
  generation: string,
) {
  requireRole(principal, "owner");
  const reviewed = "generation" in input ? input : null;
  if ((reviewed?.generation ?? initialSyncGeneration) !== generation)
    throw new DomainError(
      "sync_generation_changed",
      "The centre was restored; review access before saving",
    );
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({ userId: staffProfile.userId })
      .from(staffProfile)
      .where(eq(staffProfile.id, staffId));
    const accountId = link?.userId ?? null;
    // Match role changes' user-before-profile order and hold the actor's authority through commit.
    const accounts = await tx
      .select({ id: user.id, role: user.role, email: user.email })
      .from(user)
      .where(inArray(user.id, accountId ? [principal.userId, accountId] : [principal.userId]))
      .orderBy(asc(user.id))
      .for("share");
    if (accounts.find((row) => row.id === principal.userId)?.role !== "owner")
      throw new DomainError("forbidden", "Only the owner can change staff access");
    const account = accounts.find((row) => row.id === accountId);
    const accountRole = account?.role ?? null;
    const [staff] = await tx
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.id, staffId))
      .for("update");
    if (!staff || staff.deletedAt) throw new DomainError("not_found", "Staff profile not found");
    if (staff.userId !== accountId || (reviewed && reviewed.accountId !== staff.userId))
      throw new DomainError(
        "version_conflict",
        "The linked staff account changed; review access before saving",
      );
    if (accountRole && accountRole !== "staff")
      throw new DomainError("invalid_state", "Access presets apply only to staff accounts");
    if (staff.accessVersion !== input.version)
      throw new DomainError("version_conflict", "Access changed; reload before saving");
    const version = staff.accessVersion + 1;
    await tx
      .update(staffProfile)
      .set({ accessPreset: input.preset, accessVersion: version })
      .where(eq(staffProfile.id, staffId));
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "staff.access_changed",
      entity: "staff_profile",
      entityId: staffId,
      metadata: { previous: staff.accessPreset, preset: input.preset, version },
    });
    return {
      generation,
      accountId: staff.userId,
      accountEmail: account?.email ?? null,
      access: { staffId, preset: input.preset, version, accountRole },
    };
  });
}
