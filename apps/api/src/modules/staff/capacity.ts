import type { StaffCapacityInput } from "@sob/contracts";
import { type Database, staffProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeStaffScheduleRead, requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars, lockScheduling } from "../../tx";
import { repackStaff } from "../availability/staff-reservations";
import { requireStaff } from "./admin";

const view = (row: typeof staffProfile.$inferSelect) => ({
  staffId: row.id,
  maxConcurrent: row.maxConcurrent,
  version: row.capacityVersion,
  effectiveAt: row.capacityEffectiveAt.toISOString(),
});
export async function getStaffCapacity(db: Database, id: string, p: Principal) {
  authorizeStaffScheduleRead(p, id);
  return view(await requireStaff(db, id));
}
export async function setStaffCapacity(
  db: Database,
  id: string,
  input: StaffCapacityInput,
  p: Principal,
  now: Date,
) {
  requirePermission(p, "editSchedules");
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    await lockCalendars(tx, [id]);
    const principal = await loadPrincipal(tx, p.userId);
    if (!principal) throw new DomainError("forbidden", "Account not available");
    requirePermission(principal, "editSchedules");
    const row = await requireStaff(tx, id);
    if (row.capacityVersion !== input.version)
      throw new DomainError(
        "version_conflict",
        "Professional capacity changed; reload before saving",
      );
    if (row.maxConcurrent === input.maxConcurrent) return view(row);
    if (now < row.capacityEffectiveAt)
      throw new DomainError(
        "invalid_state",
        "The server clock moved before the last capacity change",
      );
    await repackStaff(tx, id, now, { capacity: input.maxConcurrent });
    const [saved] = await tx
      .update(staffProfile)
      .set({
        maxConcurrent: input.maxConcurrent,
        capacityVersion: row.capacityVersion + 1,
        capacityEffectiveAt: now,
      })
      .where(eq(staffProfile.id, id))
      .returning();
    if (!saved) throw new Error("Missing capacity update");
    await recordAudit(tx, {
      actorUserId: p.userId,
      action: "staff.capacity_updated",
      entity: "staff",
      entityId: id,
      metadata: {
        from: row.maxConcurrent,
        to: input.maxConcurrent,
        version: saved.capacityVersion,
      },
    });
    return view(saved);
  });
}
