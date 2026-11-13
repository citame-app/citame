import type { Staff } from "@sob/contracts";
import { type Database, serviceStaff, staffProfile } from "@sob/db";
import { and, asc, eq, isNull } from "drizzle-orm";

export async function listStaff(db: Database): Promise<Staff[]> {
  const members = await db
    .select({ id: staffProfile.id, displayName: staffProfile.displayName })
    .from(staffProfile)
    .where(and(eq(staffProfile.active, true), isNull(staffProfile.deletedAt)))
    .orderBy(asc(staffProfile.displayName));

  const links = await db
    .select({ staffId: serviceStaff.staffId, serviceId: serviceStaff.serviceId })
    .from(serviceStaff)
    .where(isNull(serviceStaff.deletedAt));

  return members.map((member) => ({
    ...member,
    serviceIds: links.filter((l) => l.staffId === member.id).map((l) => l.serviceId),
  }));
}
