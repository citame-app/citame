import { describe, expect, test } from "bun:test";
import {
  adminServiceSchema,
  createServiceRequestSchema,
  listAdminServicesResponseSchema,
  setServiceStaffRequestSchema,
  updateServiceRequestSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const uuid2 = "0198f5a0-7b1c-7000-8000-000000000002";

describe("create service request", () => {
  const valid = { name: "Haircut", durationMinutes: 45, priceCents: 12000 };

  test("accepts the minimum and applies no hidden defaults", () => {
    const parsed = createServiceRequestSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  test("accepts optional description, buffer and currency", () => {
    const parsed = createServiceRequestSchema.parse({
      ...valid,
      description: "Wash and cut",
      bufferMinutes: 10,
      currency: "ARS",
    });
    expect(parsed.bufferMinutes).toBe(10);
  });

  test("rejects blank names, non-positive durations and negative money", () => {
    for (const bad of [
      { ...valid, name: "   " },
      { ...valid, durationMinutes: 0 },
      { ...valid, durationMinutes: 1.5 },
      { ...valid, bufferMinutes: -1 },
      { ...valid, priceCents: -1 },
      { ...valid, currency: "PESOS" },
    ]) {
      expect(createServiceRequestSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("update service request", () => {
  test("accepts a partial change including activation", () => {
    expect(updateServiceRequestSchema.safeParse({ priceCents: 5 }).success).toBe(true);
    expect(updateServiceRequestSchema.safeParse({ active: false }).success).toBe(true);
    expect(updateServiceRequestSchema.safeParse({ description: null }).success).toBe(true);
  });

  test("requires at least one field and validates the ones it has", () => {
    expect(updateServiceRequestSchema.safeParse({}).success).toBe(false);
    expect(updateServiceRequestSchema.safeParse({ durationMinutes: -1 }).success).toBe(false);
  });
});

describe("set service staff request", () => {
  test("accepts a list of unique staff ids, including an empty one", () => {
    expect(setServiceStaffRequestSchema.safeParse({ staffIds: [uuid, uuid2] }).success).toBe(true);
    expect(setServiceStaffRequestSchema.safeParse({ staffIds: [] }).success).toBe(true);
  });

  test("rejects duplicates and malformed ids", () => {
    expect(setServiceStaffRequestSchema.safeParse({ staffIds: [uuid, uuid] }).success).toBe(false);
    expect(setServiceStaffRequestSchema.safeParse({ staffIds: ["nope"] }).success).toBe(false);
    expect(setServiceStaffRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe("admin service responses", () => {
  const service = {
    id: uuid,
    name: "Haircut",
    description: null,
    durationMinutes: 45,
    bufferMinutes: 10,
    priceCents: 12000,
    currency: "ARS",
    active: true,
    staffIds: [uuid2],
  };

  test("parses a service with its activation flag and performers", () => {
    expect(adminServiceSchema.parse(service).staffIds).toEqual([uuid2]);
    expect(listAdminServicesResponseSchema.parse({ services: [service] }).services).toHaveLength(1);
  });

  test("requires the admin-only fields", () => {
    const { active: _a, ...withoutActive } = service;
    expect(adminServiceSchema.safeParse(withoutActive).success).toBe(false);
  });
});
