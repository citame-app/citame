import { describe, expect, test } from "bun:test";
import {
  appointmentListQuerySchema,
  appointmentSchema,
  availabilityQuerySchema,
  availabilityResponseSchema,
  createAppointmentBaseSchema,
  createAppointmentRequestSchema,
  errorCodeSchema,
  errorResponseSchema,
  errorStatus,
  serviceSchema,
  staffSchema,
  updateAppointmentRequestSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const uuid2 = "0198f5a0-7b1c-7000-8000-000000000002";

describe("error shape", () => {
  test("accepts the stable { error: { code, message } } shape", () => {
    const parsed = errorResponseSchema.parse({
      error: { code: "slot_taken", message: "The slot is no longer available" },
    });
    expect(parsed.error.code).toBe("slot_taken");
  });

  test("rejects unknown error codes", () => {
    expect(errorCodeSchema.safeParse("boom").success).toBe(false);
  });

  test("covers the documented codes", () => {
    for (const code of [
      "slot_taken",
      "validation_error",
      "not_found",
      "version_conflict",
      "has_future_appointments",
      "slot_unavailable",
    ]) {
      expect(errorCodeSchema.safeParse(code).success).toBe(true);
    }
  });

  test("the new admin codes are conflicts (409)", () => {
    expect(errorStatus.has_future_appointments).toBe(409);
    expect(errorStatus.slot_unavailable).toBe(409);
  });
});

describe("service and staff", () => {
  test("parses a service", () => {
    const service = serviceSchema.parse({
      id: uuid,
      name: "Haircut",
      description: null,
      durationMinutes: 45,
      bufferMinutes: 10,
      priceCents: 12000,
      currency: "ARS",
    });
    expect(service.durationMinutes).toBe(45);
  });

  test("rejects non-positive duration", () => {
    const result = serviceSchema.safeParse({
      id: uuid,
      name: "Haircut",
      description: null,
      durationMinutes: 0,
      bufferMinutes: 0,
      priceCents: 0,
      currency: "ARS",
    });
    expect(result.success).toBe(false);
  });

  test("parses a staff member with the services they perform", () => {
    const staff = staffSchema.parse({ id: uuid, displayName: "Ana", serviceIds: [uuid2] });
    expect(staff.serviceIds).toEqual([uuid2]);
  });
});

describe("self-service booking", () => {
  const base = { staffId: uuid, serviceIds: [uuid2], startsAt: "2026-03-09T12:00:00.000Z" };

  test("the base shape needs no client identity (the server pins it for clients)", () => {
    expect(createAppointmentBaseSchema.safeParse(base).success).toBe(true);
    expect(createAppointmentRequestSchema.safeParse(base).success).toBe(false);
  });

  test("the base shape still validates the booking fields", () => {
    expect(createAppointmentBaseSchema.safeParse({ ...base, serviceIds: [] }).success).toBe(false);
    expect(createAppointmentBaseSchema.safeParse({ ...base, startsAt: "soon" }).success).toBe(
      false,
    );
  });
});

describe("availability", () => {
  test("parses comma-separated serviceIds into an array", () => {
    const query = availabilityQuerySchema.parse({
      serviceIds: `${uuid},${uuid2}`,
      date: "2026-03-09",
    });
    expect(query.serviceIds).toEqual([uuid, uuid2]);
    expect(query.staffId).toBeUndefined();
  });

  test("rejects an empty serviceIds list", () => {
    expect(availabilityQuerySchema.safeParse({ serviceIds: "", date: "2026-03-09" }).success).toBe(
      false,
    );
  });

  test("rejects a malformed date", () => {
    expect(
      availabilityQuerySchema.safeParse({ serviceIds: uuid, date: "09/03/2026" }).success,
    ).toBe(false);
  });

  test("parses a response", () => {
    const res = availabilityResponseSchema.parse({
      date: "2026-03-09",
      timezone: "America/Argentina/Buenos_Aires",
      slots: [
        { staffId: uuid, startsAt: "2026-03-09T12:00:00.000Z", endsAt: "2026-03-09T12:55:00.000Z" },
      ],
    });
    expect(res.slots).toHaveLength(1);
  });
});

describe("appointments", () => {
  const base = {
    staffId: uuid,
    serviceIds: [uuid2],
    startsAt: "2026-03-09T12:00:00.000Z",
  };

  test("create accepts an existing clientId", () => {
    const parsed = createAppointmentRequestSchema.parse({ ...base, clientId: uuid2 });
    expect(parsed.clientId).toBe(uuid2);
  });

  test("create accepts an inline client and a client-generated id", () => {
    const parsed = createAppointmentRequestSchema.parse({
      ...base,
      id: uuid,
      client: { name: "Lucia", phone: "+5491155550000" },
    });
    expect(parsed.id).toBe(uuid);
    expect(parsed.client?.name).toBe("Lucia");
  });

  test("create requires exactly one of clientId or client", () => {
    expect(createAppointmentRequestSchema.safeParse(base).success).toBe(false);
    expect(
      createAppointmentRequestSchema.safeParse({
        ...base,
        clientId: uuid2,
        client: { name: "Lucia" },
      }).success,
    ).toBe(false);
  });

  test("create requires at least one service", () => {
    expect(
      createAppointmentRequestSchema.safeParse({ ...base, serviceIds: [], clientId: uuid2 })
        .success,
    ).toBe(false);
  });

  test("create rejects a startsAt without an offset", () => {
    expect(
      createAppointmentRequestSchema.safeParse({
        ...base,
        startsAt: "2026-03-09T12:00:00",
        clientId: uuid2,
      }).success,
    ).toBe(false);
  });

  test("update requires a version", () => {
    expect(updateAppointmentRequestSchema.safeParse({ status: "cancelled" }).success).toBe(false);
  });

  test("update requires at least one change", () => {
    expect(updateAppointmentRequestSchema.safeParse({ version: 1 }).success).toBe(false);
  });

  test("update accepts cancel and reschedule", () => {
    expect(
      updateAppointmentRequestSchema.safeParse({ version: 1, status: "cancelled" }).success,
    ).toBe(true);
    expect(
      updateAppointmentRequestSchema.safeParse({
        version: 2,
        startsAt: "2026-03-10T12:00:00.000Z",
        staffId: uuid2,
      }).success,
    ).toBe(true);
  });

  test("update only allows cancelling through status", () => {
    expect(updateAppointmentRequestSchema.safeParse({ version: 1, status: "booked" }).success).toBe(
      false,
    );
  });

  test("list query requires from and to and rejects an inverted range", () => {
    expect(appointmentListQuerySchema.safeParse({ from: "2026-03-09T00:00:00Z" }).success).toBe(
      false,
    );
    expect(
      appointmentListQuerySchema.safeParse({
        from: "2026-03-10T00:00:00Z",
        to: "2026-03-09T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      appointmentListQuerySchema.safeParse({
        from: "2026-03-09T00:00:00Z",
        to: "2026-03-10T00:00:00Z",
        staffId: uuid,
      }).success,
    ).toBe(true);
  });

  test("appointment response parses with its service snapshots", () => {
    const parsed = appointmentSchema.parse({
      id: uuid,
      staffId: uuid,
      clientId: uuid2,
      startsAt: "2026-03-09T12:00:00.000Z",
      endsAt: "2026-03-09T12:55:00.000Z",
      status: "booked",
      notes: null,
      version: 1,
      services: [
        {
          serviceId: uuid2,
          name: "Haircut",
          durationMinutes: 45,
          bufferMinutes: 10,
          priceCents: 12000,
          currency: "ARS",
        },
      ],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    });
    expect(parsed.services[0]?.name).toBe("Haircut");
  });
});
