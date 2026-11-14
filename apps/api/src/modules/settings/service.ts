import type { SalonResponse, UpdateSalonSettingsRequest } from "@sob/contracts";
import { type Database, salonSettings } from "@sob/db";
import { eq } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";

export async function getSalonSettings(db: Pick<Database, "select">) {
  const [settings] = await db.select().from(salonSettings).limit(1);
  if (!settings) {
    throw new DomainError("internal_error", "Salon settings are not configured; run db:seed");
  }
  return settings;
}

type Row = Awaited<ReturnType<typeof getSalonSettings>>;

export function toSalonResponse(settings: Row): SalonResponse {
  return {
    name: settings.name,
    timezone: settings.timezone,
    slotGranularityMinutes: settings.slotGranularityMinutes,
    minNoticeMinutes: settings.minNoticeMinutes,
    maxDaysAhead: settings.maxDaysAhead,
  };
}

const EDITABLE = [
  "name",
  "timezone",
  "slotGranularityMinutes",
  "minNoticeMinutes",
  "maxDaysAhead",
] as const;

/** Edits the single settings row; a request that changes nothing writes nothing and audits nothing. */
export async function updateSalonSettings(
  db: Database,
  input: UpdateSalonSettingsRequest,
  actor: { userId: string },
): Promise<SalonResponse> {
  return db.transaction(async (tx) => {
    const current = await getSalonSettings(tx);
    const changes = Object.fromEntries(
      EDITABLE.filter((key) => input[key] !== undefined && input[key] !== current[key]).map(
        (key) => [key, input[key]],
      ),
    );
    const fields = Object.keys(changes);
    if (fields.length === 0) return toSalonResponse(current);
    const [updated] = await tx
      .update(salonSettings)
      .set({ ...changes, updatedAt: new Date() })
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
    return toSalonResponse(updated);
  });
}
