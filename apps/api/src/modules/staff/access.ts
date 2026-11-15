import type { StaffAccessPreset } from "@sob/contracts";
import { type Database, staffProfile, user } from "@sob/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { requireStaff } from "./admin";
export async function getStaffAccess(db: Database, staffId: string, principal: Principal) {
  requireRole(principal, "owner");
  const staff = await requireStaff(db, staffId);
  const [account] = staff.userId
    ? await db.select({ role: user.role }).from(user).where(eq(user.id, staff.userId))
    : [];
  return {
    staffId,
    preset: staff.accessPreset,
    version: staff.accessVersion,
    accountRole: account?.role ?? null,
  };
}
export async function setStaffAccess(
  db: Database,
  staffId: string,
  input: { preset: StaffAccessPreset; version: number },
  principal: Principal,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    const [staff] = await tx
      .select()
      .from(staffProfile)
      .where(eq(staffProfile.id, staffId))
      .for("update");
    if (!staff || staff.deletedAt) throw new DomainError("not_found", "Staff profile not found");
    const [account] = staff.userId
      ? await tx.select({ role: user.role }).from(user).where(eq(user.id, staff.userId))
      : [];
    if (account && account.role !== "staff")
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
    return { staffId, preset: input.preset, version, accountRole: account?.role ?? null };
  });
}
