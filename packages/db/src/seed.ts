import type { Database } from "./client";
import { salonSettings, service, serviceStaff, staffProfile, workingHours } from "./schema";

/**
 * SAMPLE DATA ONLY. Generic placeholder salon content for development and demos; it is not
 * real business data. Rows use fixed UUIDv7-shaped ids and `ON CONFLICT DO NOTHING`, so the
 * seed is idempotent and never overwrites edits made after the first run.
 */

const id = (n: number) => `0198f5a0-7b1c-7000-8000-${n.toString(16).padStart(12, "0")}`;

const SERVICES = [
  { id: id(0x101), name: "Haircut", durationMinutes: 45, bufferMinutes: 15, priceCents: 1_500_000 },
  {
    id: id(0x102),
    name: "Blow dry",
    durationMinutes: 30,
    bufferMinutes: 10,
    priceCents: 1_000_000,
  },
  {
    id: id(0x103),
    name: "Hair color",
    durationMinutes: 90,
    bufferMinutes: 15,
    priceCents: 4_500_000,
  },
  {
    id: id(0x104),
    name: "Manicure",
    durationMinutes: 45,
    bufferMinutes: 10,
    priceCents: 1_200_000,
  },
  {
    id: id(0x105),
    name: "Pedicure",
    durationMinutes: 60,
    bufferMinutes: 10,
    priceCents: 1_600_000,
  },
  {
    id: id(0x106),
    name: "Eyebrow shaping",
    durationMinutes: 20,
    bufferMinutes: 5,
    priceCents: 600_000,
  },
] as const;

const STAFF = [
  { id: id(0x201), displayName: "Stylist A", serviceIds: SERVICES.slice(0, 3).map((s) => s.id) },
  { id: id(0x202), displayName: "Stylist B", serviceIds: SERVICES.slice(3).map((s) => s.id) },
] as const;

const WEEKDAYS = [1, 2, 3, 4, 5]; // Monday to Friday

export async function seedSampleData(db: Database): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .insert(salonSettings)
      .values({
        id: 1,
        name: "Sisters of Beauty",
        timezone: "America/Argentina/Buenos_Aires",
        slotGranularityMinutes: 15,
        minNoticeMinutes: 60,
        maxDaysAhead: 60,
      })
      .onConflictDoNothing();

    await tx
      .insert(service)
      .values(SERVICES.map((s) => ({ ...s, description: null })))
      .onConflictDoNothing();

    await tx
      .insert(staffProfile)
      .values(STAFF.map((s) => ({ id: s.id, displayName: s.displayName })))
      .onConflictDoNothing();

    await tx
      .insert(serviceStaff)
      .values(
        STAFF.flatMap((member, m) =>
          member.serviceIds.map((serviceId, i) => ({
            id: id(0x300 + m * 0x10 + i),
            serviceId,
            staffId: member.id,
          })),
        ),
      )
      .onConflictDoNothing();

    await tx
      .insert(workingHours)
      .values(
        STAFF.flatMap((member, m) =>
          WEEKDAYS.map((weekday) => ({
            id: id(0x400 + m * 0x10 + weekday),
            staffId: member.id,
            weekday,
            startTime: "09:00",
            endTime: "18:00",
          })),
        ),
      )
      .onConflictDoNothing();
  });
}
