import { describe, expect, test } from "bun:test";
import {
  createAppointmentRequestSchema,
  createServiceRequestSchema,
  createStaffAccountRequestSchema,
  createTimeOffRequestSchema,
  LIMITS,
  syncMutationSchema,
  updateAppointmentRequestSchema,
  updateClientRequestSchema,
  updateServiceRequestSchema,
  updateStaffRequestSchema,
} from "./index";

const id = "0192f0a0-0000-7000-8000-000000000001";
const id2 = "0192f0a0-0000-7000-8000-000000000002";
const when = "2026-03-09T12:00:00.000Z";
const long = (n: number) => "x".repeat(n);
const envelope = { mutationId: "0192f0a0-0000-7000-8000-0000000000aa", createdAt: when };

describe("free-text limits", () => {
  test("the limits are the documented ones", () => {
    expect(LIMITS).toEqual({
      name: 200,
      phone: 32,
      email: 254,
      notes: 2000,
      description: 2000,
      reason: 500,
    });
  });

  test("appointment notes and the inline client are capped", () => {
    const base = { staffId: id, serviceIds: [id2], startsAt: when };
    const ok = { ...base, client: { name: "Lucia" }, notes: long(LIMITS.notes) };
    expect(createAppointmentRequestSchema.safeParse(ok).success).toBe(true);
    for (const bad of [
      { ...ok, notes: long(LIMITS.notes + 1) },
      { ...ok, client: { name: long(LIMITS.name + 1) } },
      { ...ok, client: { name: "L", phone: long(LIMITS.phone + 1) } },
      { ...ok, client: { name: "L", email: `${long(LIMITS.email)}@example.com` } },
    ]) {
      expect(createAppointmentRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("update notes are capped", () => {
    expect(
      updateAppointmentRequestSchema.safeParse({ version: 1, notes: long(2000) }).success,
    ).toBe(true);
    expect(
      updateAppointmentRequestSchema.safeParse({ version: 1, notes: long(2001) }).success,
    ).toBe(false);
  });

  test("sync client and appointment mutations are capped", () => {
    const create = (payload: object) => ({
      ...envelope,
      kind: "client.create",
      payload: { id, name: "Lucia", ...payload },
    });
    expect(syncMutationSchema.safeParse(create({ notes: long(2000) })).success).toBe(true);
    for (const payload of [
      { notes: long(2001) },
      { name: long(201) },
      { phone: long(33) },
      { email: `${long(254)}@example.com` },
    ]) {
      expect(syncMutationSchema.safeParse(create(payload)).success).toBe(false);
    }
    const update = (payload: object) => ({
      ...envelope,
      kind: "client.update",
      payload: { id, ...payload },
    });
    expect(syncMutationSchema.safeParse(update({ notes: long(2001) })).success).toBe(false);
    expect(syncMutationSchema.safeParse(update({ name: long(201) })).success).toBe(false);
    expect(syncMutationSchema.safeParse(update({ phone: long(33) })).success).toBe(false);
    const status = (notes: string) => ({
      ...envelope,
      kind: "appointment.set_status",
      payload: { id, version: 1, status: "completed", notes },
    });
    expect(syncMutationSchema.safeParse(status(long(2000))).success).toBe(true);
    expect(syncMutationSchema.safeParse(status(long(2001))).success).toBe(false);
    const reschedule = (notes: string) => ({
      ...envelope,
      kind: "appointment.reschedule",
      payload: { id, version: 1, startsAt: when, notes },
    });
    expect(syncMutationSchema.safeParse(reschedule(long(2001))).success).toBe(false);
    const timeOff = (reason: string) => ({
      ...envelope,
      kind: "time_off.create",
      payload: { id, staffId: id2, startsAt: when, endsAt: "2026-03-09T13:00:00.000Z", reason },
    });
    expect(syncMutationSchema.safeParse(timeOff(long(501))).success).toBe(false);
  });

  test("admin writes are capped too", () => {
    expect(
      updateClientRequestSchema.safeParse({ name: "A", phone: null, notes: long(2001) }).success,
    ).toBe(false);
    expect(
      updateClientRequestSchema.safeParse({ name: long(201), phone: null, notes: null }).success,
    ).toBe(false);
    expect(
      createServiceRequestSchema.safeParse({
        name: "Cut",
        durationMinutes: 30,
        priceCents: 1,
        description: long(2001),
      }).success,
    ).toBe(false);
    expect(updateServiceRequestSchema.safeParse({ name: long(201) }).success).toBe(false);
    expect(
      updateStaffRequestSchema.safeParse({ displayName: long(201), active: true }).success,
    ).toBe(false);
    expect(
      createTimeOffRequestSchema.safeParse({
        startsAt: when,
        endsAt: "2026-03-09T13:00:00.000Z",
        reason: long(501),
      }).success,
    ).toBe(false);
    expect(
      createStaffAccountRequestSchema.safeParse({ email: "a@example.com", name: long(201) })
        .success,
    ).toBe(false);
  });
});
