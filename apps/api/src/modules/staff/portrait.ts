import type { StaffPortraitInput, StaffPortraitPublication } from "@sob/contracts";
import { type Database, staffPortrait, staffProfile } from "@sob/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeStaffAdmin, authorizeStaffScheduleRead } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars } from "../../tx";
import { normalizeClientPhoto } from "../clients/photo-image";
import { requireStaff } from "./admin";

export async function readStaffPortrait(
  db: Database,
  staffId: string,
  principal: Principal,
  version?: string,
) {
  authorizeStaffScheduleRead(principal, staffId);
  return portraitResponse(db, staffId, version);
}

export function readPublishedStaffPortrait(db: Database, staffId: string, version: string) {
  return portraitResponse(db, staffId, version, true);
}

async function portraitResponse(
  db: Database,
  staffId: string,
  version?: string,
  published = false,
) {
  const [row] = await db
    .select({ image: staffPortrait.image })
    .from(staffPortrait)
    .innerJoin(staffProfile, eq(staffProfile.id, staffPortrait.staffId))
    .where(
      and(
        eq(staffPortrait.staffId, staffId),
        isNull(staffProfile.deletedAt),
        version === undefined ? undefined : eq(staffPortrait.version, version),
        published
          ? and(eq(staffProfile.active, true), eq(staffPortrait.published, true))
          : undefined,
      ),
    );
  if (!row) throw new DomainError("not_found", "Staff portrait not found");
  return new Response(new Uint8Array(row.image), {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store" },
  });
}

export async function saveStaffPortrait(
  db: Database,
  staffId: string,
  input: StaffPortraitInput | StaffPortraitPublication,
  principal: Principal,
) {
  authorizeStaffAdmin(principal);
  await requireStaff(db, staffId);
  const photo =
    "imageBase64" in input && input.imageBase64
      ? await normalizeClientPhoto(input.imageBase64)
      : null;
  return db.transaction(async (tx) => {
    await lockCalendars(tx, [staffId]);
    const live = await loadPrincipal(tx, principal.userId);
    if (!live) throw new DomainError("forbidden", "This account is no longer available");
    authorizeStaffAdmin(live);
    const staff = await requireStaff(tx, staffId);
    const [current] = await tx
      .select({ version: staffPortrait.version, published: staffPortrait.published })
      .from(staffPortrait)
      .where(eq(staffPortrait.staffId, staffId));
    if ((current?.version ?? staff.portraitAbsenceVersion) !== input.version)
      throw new DomainError("version_conflict", "The portrait changed. Reload before saving.");
    let version: string | null;
    let action: string;
    if ("published" in input) {
      if (!current) throw new DomainError("not_found", "Staff portrait not found");
      if (current.published === input.published) return { version: current.version };
      version = crypto.randomUUID();
      await tx
        .update(staffPortrait)
        .set({ version, published: input.published })
        .where(eq(staffPortrait.staffId, staffId));
      action = input.published ? "staff.portrait_published" : "staff.portrait_unpublished";
    } else if (photo) {
      version = crypto.randomUUID();
      const contents = { version, image: photo.image, published: false };
      await tx
        .insert(staffPortrait)
        .values({ staffId, ...contents })
        .onConflictDoUpdate({ target: staffPortrait.staffId, set: contents });
      action = "staff.portrait_saved";
    } else {
      if (!current) return { version: null };
      await tx.delete(staffPortrait).where(eq(staffPortrait.staffId, staffId));
      version = null;
      action = "staff.portrait_removed";
    }
    // Reannounce the profile without changing the offline staff-edit conflict clock.
    await tx
      .update(staffProfile)
      .set({
        updatedAt: sql`${staffProfile.updatedAt}`,
        portraitAbsenceVersion: version === null ? crypto.randomUUID() : null,
      })
      .where(eq(staffProfile.id, staffId));
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action,
      entity: "staff",
      entityId: staffId,
    });
    return { version };
  });
}
