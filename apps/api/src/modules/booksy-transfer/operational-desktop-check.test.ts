import { expect, test } from "bun:test";
import type { CalendarAppointment, CalendarResponse } from "@sob/contracts";
import { hydrateRehearsalDesktop } from "./operational-desktop-check";

const startsAt = "2026-11-25T09:00:00.000Z";
const endsAt = "2026-11-25T09:30:00.000Z";
const visit: CalendarAppointment = {
  id: Bun.randomUUIDv7(),
  staffId: Bun.randomUUIDv7(),
  clientId: Bun.randomUUIDv7(),
  clientName: "Rehearsal client",
  startsAt,
  endsAt,
  status: "booked",
  version: 1,
  notes: null,
  services: [
    {
      serviceId: Bun.randomUUIDv7(),
      name: "Treatment",
      durationMinutes: 30,
      bufferMinutes: 0,
      priceCents: 4200,
      currency: "EUR",
    },
  ],
  serviceNames: ["Treatment"],
  importedFromBooksy: true,
  resources: [{ resourceId: Bun.randomUUIDv7(), name: "Equipment", quantity: 1 }],
  serviceBadges: [
    {
      servicePosition: 0,
      requested: true,
      paid: true,
      invoiced: true,
      billingSource: "booksy",
      internalNote: true,
      customerComment: false,
    },
  ],
  createdAt: startsAt,
  updatedAt: startsAt,
};
const calendar: CalendarResponse = {
  from: startsAt,
  to: endsAt,
  timezone: "Europe/Madrid",
  staff: [{ id: visit.staffId, displayName: "Professional" }],
  appointments: [visit],
  workingWindows: [],
  timeOff: [],
};

function pull(data: CalendarAppointment) {
  return () =>
    Response.json({
      changes: [{ seq: 1, entity: "appointment", id: visit.id, op: "upsert", data }],
      generation: "rehearsal",
      viewerRole: "owner",
      nextCursor: 1,
      headSeq: 1,
      hasMore: false,
    });
}

test("the rehearsal rejects a replica missing booked equipment", async () => {
  await expect(hydrateRehearsalDesktop(pull(visit), "rehearsal", calendar)).resolves.toBe(1);
  await expect(
    hydrateRehearsalDesktop(pull({ ...visit, resources: [] }), "rehearsal", calendar),
  ).rejects.toThrow("restored agenda");
});

test("the rehearsal treats resource lists as unordered and checks frozen prices", async () => {
  const resources = [
    ...(visit.resources ?? []),
    { resourceId: Bun.randomUUIDv7(), name: "Room", quantity: 1 },
  ];
  const expected = { ...calendar, appointments: [{ ...visit, resources }] };
  const synced = { ...visit, resources: resources.toReversed() };
  await expect(hydrateRehearsalDesktop(pull(synced), "rehearsal", expected)).resolves.toBe(1);
  await expect(
    hydrateRehearsalDesktop(
      pull({
        ...synced,
        services: synced.services.map((service) => ({ ...service, priceCents: 1 })),
      }),
      "rehearsal",
      expected,
    ),
  ).rejects.toThrow("restored agenda");
});

test("the rehearsal requires imported badges but tolerates omitted empty badges", async () => {
  const invisibleBadges = [
    {
      servicePosition: 0,
      requested: false,
      paid: false,
      invoiced: false,
      billingSource: null,
      internalNote: false,
      customerComment: false,
    },
  ];
  const noBadges = { ...visit, serviceBadges: undefined };
  await expect(hydrateRehearsalDesktop(pull(noBadges), "rehearsal", calendar)).rejects.toThrow(
    "restored agenda",
  );
  await expect(
    hydrateRehearsalDesktop(pull(noBadges), "rehearsal", {
      ...calendar,
      appointments: [{ ...visit, serviceBadges: invisibleBadges }],
    }),
  ).resolves.toBe(1);
});
