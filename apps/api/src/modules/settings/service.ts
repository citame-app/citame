import { type Database, salonSettings } from "@sob/db";
import { DomainError } from "../../errors";

export async function getSalonSettings(db: Pick<Database, "select">) {
  const [settings] = await db.select().from(salonSettings).limit(1);
  if (!settings) {
    throw new DomainError("internal_error", "Salon settings are not configured; run db:seed");
  }
  return settings;
}
