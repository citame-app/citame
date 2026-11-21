import type { Staff } from "@sob/contracts";
import { type Database, serviceStaff, staffPortrait, staffProfile } from "@sob/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { DomainError } from "../../errors";

export async function listStaff(db: Database): Promise<Staff[]> {
  const members = await db
    .select({
      id: staffProfile.id,
      displayName: staffProfile.displayName,
      portraitVersion: staffPortrait.version,
    })
    .from(staffProfile)
    .leftJoin(
      staffPortrait,
      and(eq(staffPortrait.staffId, staffProfile.id), eq(staffPortrait.published, true)),
    )
    .where(and(eq(staffProfile.active, true), isNull(staffProfile.deletedAt)))
    .orderBy(asc(staffProfile.displayName));

  const links = await db
    .select({ staffId: serviceStaff.staffId, serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .where(isNull(serviceStaff.deletedAt));

  return members.map(({ portraitVersion, ...member }) => ({
    ...member,
    ...(portraitVersion ? { portraitVersion } : {}),
    serviceIds: links.filter((l) => l.staffId === member.id).map((l) => l.serviceId),
  }));
}

export async function assertStaffExists(
  db: Pick<Database, "select">,
  staffId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: staffProfile.id })
    .from(staffProfile)
    .where(
      and(
        eq(staffProfile.id, staffId),
        eq(staffProfile.active, true),
        isNull(staffProfile.deletedAt),
      ),
    );
  if (!row) throw new DomainError("not_found", `Staff member ${staffId} not found`);
}

/** Active professional assignments for the requested services. */
export async function activeServiceAssignments(
  db: Pick<Database, "select">,
  serviceIds: readonly string[],
) {
  if (!serviceIds.length) return [];
  return db
    .select({ staffId: serviceStaff.staffId, serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .innerJoin(staffProfile, eq(staffProfile.id, serviceStaff.staffId))
    .where(
      and(
        inArray(serviceStaff.serviceId, serviceIds),
        isNull(serviceStaff.deletedAt),
        eq(staffProfile.active, true),
        isNull(staffProfile.deletedAt),
      ),
    );
}

/** Ids of active staff who perform every one of the given services. */
export async function staffQualifiedFor(
  db: Pick<Database, "select">,
  serviceIds: string[],
): Promise<string[]> {
  const rows = await activeServiceAssignments(db, serviceIds);
  const counts = new Map<string, Set<string>>();
  for (const row of rows) {
    const set = counts.get(row.staffId) ?? new Set<string>();
    set.add(row.serviceId);
    counts.set(row.staffId, set);
  }
  const needed = new Set(serviceIds).size;
  return [...counts].filter(([, set]) => set.size === needed).map(([id]) => id);
}
