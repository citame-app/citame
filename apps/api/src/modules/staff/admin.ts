import type { AdminStaff, UpdateStaffRequest } from "@sob/contracts";
import { type Database, serviceStaff, staffProfile } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { lockCalendars } from "../../tx";
import { assertNoFutureAppointments } from "./guards";

type Executor = Pick<Database, "select">;
type StaffRow = typeof staffProfile.$inferSelect;

export interface AdminActor {
  userId: string;
}

function toAdminStaff(row: StaffRow, serviceIds: string[]): AdminStaff {
  return {
    id: row.id,
    displayName: row.displayName,
    active: row.active,
    userId: row.userId,
    serviceIds,
  };
}

async function loadServiceIds(db: Executor, staffIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (staffIds.length === 0) return map;
  const links = await db
    .select({ staffId: serviceStaff.staffId, serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .where(and(inArray(serviceStaff.staffId, staffIds), isNull(serviceStaff.deletedAt)));
  for (const link of links) {
    map.set(link.staffId, [...(map.get(link.staffId) ?? []), link.serviceId]);
  }
  return map;
}

/** Loads a non-deleted staff profile (inactive ones included) or throws `not_found`. */
export async function requireStaff(db: Executor, id: string): Promise<StaffRow> {
  const [row] = await db
    .select()
    .from(staffProfile)
    .where(and(eq(staffProfile.id, id), isNull(staffProfile.deletedAt)));
  if (!row) throw new DomainError("not_found", `Staff member ${id} not found`);
  return row;
}

/** The whole team (inactive included), or just one member when `only` is given. */
export async function listAdminStaff(
  db: Database,
  only: { staffId?: string } = {},
): Promise<AdminStaff[]> {
  const rows = await db
    .select()
    .from(staffProfile)
    .where(
      and(
        isNull(staffProfile.deletedAt),
        only.staffId ? eq(staffProfile.id, only.staffId) : undefined,
      ),
    )
    .orderBy(asc(staffProfile.displayName), asc(staffProfile.id));
  const services = await loadServiceIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((row) => toAdminStaff(row, services.get(row.id) ?? []));
}

/**
 * Renames and/or (de)activates a staff calendar. Deactivation is refused with
 * `has_future_appointments` while upcoming bookings exist; the check runs under the calendar
 * lock so a booking cannot slip in between the check and the update.
 */
export async function updateStaff(
  db: Database,
  id: string,
  input: UpdateStaffRequest,
  actor: AdminActor,
  now: Date,
): Promise<AdminStaff> {
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [id]);
    const current = await requireStaff(tx, id);
    const changes: Partial<Pick<StaffRow, "displayName" | "active">> = {};
    if (input.displayName !== undefined && input.displayName !== current.displayName) {
      changes.displayName = input.displayName;
    }
    if (input.active !== undefined && input.active !== current.active) {
      changes.active = input.active;
    }
    const serviceIds = (await loadServiceIds(tx, [id])).get(id) ?? [];
    const changed = Object.keys(changes).sort();
    if (changed.length === 0) return toAdminStaff(current, serviceIds);

    if (changes.active === false) await assertNoFutureAppointments(tx, id, now);

    const [updated] = await tx
      .update(staffProfile)
      .set(changes)
      .where(eq(staffProfile.id, id))
      .returning();
    if (!updated) throw new Error("Staff update returned no row");

    const action =
      "active" in changes
        ? updated.active
          ? "staff.activate"
          : "staff.deactivate"
        : "staff.update";
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action,
      entity: "staff",
      entityId: id,
      metadata: { changed },
    });
    return toAdminStaff(updated, serviceIds);
  });
}
