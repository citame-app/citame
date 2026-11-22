import { isDeepStrictEqual } from "node:util";
import {
  applyOpeningScheduleEdits,
  businessProfileSchema,
  EMPTY_BUSINESS_PROFILE,
  EMPTY_OPENING_SCHEDULE,
  type OwnerSalonSettings,
  type ReviewedSalonChanges,
  type ReviewedSalonSettings,
  type SalonResponse,
  type UpdateSalonSettingsRequest,
} from "@sob/contracts";
import { type Database, salonSettings } from "@sob/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";

export async function getSalonSettings(db: Pick<Database, "select">, lock?: "share" | "update") {
  const query = db.select().from(salonSettings).limit(1);
  const [settings] = await (lock ? query.for(lock) : query);
  if (!settings) {
    throw new DomainError("internal_error", "Salon settings are not configured; run db:seed");
  }
  return settings;
}

type Row = Awaited<ReturnType<typeof getSalonSettings>>;

const businessProfile = (settings: Row) =>
  businessProfileSchema.parse({ ...EMPTY_BUSINESS_PROFILE, ...settings.businessProfile });

export function toSalonResponse(settings: Row): SalonResponse {
  return {
    name: settings.name,
    timezone: settings.timezone,
    slotGranularityMinutes: settings.slotGranularityMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxDaysAhead: settings.maxDaysAhead,
    onlineBookingEnabled: settings.onlineBookingEnabled,
  };
}

export function toPublicBusinessProfile(settings: Row) {
  const { published, openingSchedule, ...profile } = businessProfile(settings);
  return published ? { profile, openingSchedule } : { profile: null };
}

export function assertOnlineBookingEnabled(settings: Row, role?: string) {
  if (role === "client" && !settings.onlineBookingEnabled)
    throw new DomainError("online_booking_paused", "New online bookings are paused");
}

export function toOwnerSettings(settings: Row): OwnerSalonSettings {
  return {
    ...toSalonResponse(settings),
    reminderFirstLeadMinutes: settings.reminderFirstLeadMinutes,
    reminderSecondLeadMinutes: settings.reminderSecondLeadMinutes,
  };
}

export function toReviewedSettings(settings: Row): ReviewedSalonSettings {
  const { openingSchedule, ...profile } = businessProfile(settings);
  return {
    ...toOwnerSettings(settings),
    onlineBookingEnabled: settings.onlineBookingEnabled,
    revision: settings.updatedAt.toISOString(),
    businessProfile: profile,
    openingSchedule,
  };
}

const EDITABLE = [
  "name",
  "timezone",
  "slotGranularityMinutes",
  "minNoticeMinutes",
  "maxDaysAhead",
  "onlineBookingEnabled",
  "reminderFirstLeadMinutes",
  "reminderSecondLeadMinutes",
] as const;

/** Edits the single settings row; a request that changes nothing writes nothing and audits nothing. */
export async function updateSalonSettings(
  db: Database,
  input: UpdateSalonSettingsRequest,
  actor: { userId: string },
): Promise<OwnerSalonSettings> {
  return toOwnerSettings(await writeSettings(db, input, actor));
}

export async function updateReviewedSettings(
  db: Database,
  input: ReviewedSalonChanges,
  actor: { userId: string },
  expectedRevision: string,
): Promise<ReviewedSalonSettings> {
  return toReviewedSettings(await writeSettings(db, input, actor, expectedRevision));
}

async function writeSettings(
  db: Database,
  input: ReviewedSalonChanges,
  actor: { userId: string },
  expectedRevision?: string,
) {
  return db.transaction(async (tx) => {
    const current = await getSalonSettings(tx, "update");
    const stale =
      expectedRevision !== undefined &&
      Date.parse(expectedRevision) !== current.updatedAt.getTime();
    const changes: Partial<typeof salonSettings.$inferInsert> = Object.fromEntries(
      EDITABLE.filter((key) => input[key] !== undefined && input[key] !== current[key]).map(
        (key) => [key, input[key]],
      ),
    );
    if (input.businessProfile !== undefined) {
      const original = businessProfile(current);
      const { openingScheduleEdits, ...profileChanges } = input.businessProfile;
      const proposed = { ...original, ...profileChanges };
      if (openingScheduleEdits) {
        proposed.openingSchedule = applyOpeningScheduleEdits(
          original.openingSchedule ?? EMPTY_OPENING_SCHEDULE,
          openingScheduleEdits,
        );
      }
      const next = businessProfileSchema.safeParse(proposed);
      if (!next.success) {
        if (stale) throw new DomainError("version_conflict", "The reviewed settings changed");
        throw new DomainError("validation_error", "The resulting opening hours are invalid");
      }
      if (!isDeepStrictEqual(next.data, original)) changes.businessProfile = next.data;
    }
    const fields = Object.keys(changes);
    if (fields.length === 0) return current;
    if (stale) throw new DomainError("version_conflict", "The reviewed settings changed");
    const [updated] = await tx
      .update(salonSettings)
      .set({
        ...changes,
        updatedAt: new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1)),
      })
      .where(eq(salonSettings.id, 1))
      .returning();
    if (!updated) throw new DomainError("internal_error", "Salon settings are not configured");
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "settings.update",
      entity: "salon_settings",
      entityId: "1",
      metadata: { fields },
    });
    return updated;
  });
}
