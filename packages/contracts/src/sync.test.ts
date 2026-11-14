import { describe, expect, test } from "bun:test";
import {
  SYNC_PULL_LIMIT_DEFAULT,
  SYNC_PULL_LIMIT_MAX,
  SYNC_PUSH_MAX_MUTATIONS,
  syncChangeSchema,
  syncMutationResultSchema,
  syncMutationSchema,
  syncPullQuerySchema,
  syncPullResponseSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
} from "./sync";

const id = () => Bun.randomUUIDv7();
const base = () => ({ mutationId: id(), createdAt: "2026-03-09T12:00:00.000Z" });

describe("syncMutationSchema", () => {
  test("accepts an appointment create with a client-assigned id", () => {
    const parsed = syncMutationSchema.safeParse({
      ...base(),
      kind: "appointment.create",
      payload: {
        id: id(),
        staffId: id(),
        serviceIds: [id()],
        startsAt: "2026-03-09T12:00:00.000Z",
        clientId: id(),
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("requires the appointment id offline clients must pre-assign", () => {
    const parsed = syncMutationSchema.safeParse({
      ...base(),
      kind: "appointment.create",
      payload: {
        staffId: id(),
        serviceIds: [id()],
        startsAt: "2026-03-09T12:00:00.000Z",
        clientId: id(),
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("requires exactly one of clientId and client on create", () => {
    const payload = {
      id: id(),
      staffId: id(),
      serviceIds: [id()],
      startsAt: "2026-03-09T12:00:00.000Z",
    };
    expect(
      syncMutationSchema.safeParse({ ...base(), kind: "appointment.create", payload }).success,
    ).toBe(false);
    expect(
      syncMutationSchema.safeParse({
        ...base(),
        kind: "appointment.create",
        payload: { ...payload, clientId: id(), client: { name: "X" } },
      }).success,
    ).toBe(false);
  });

  test("rejects a mutation id that is not a UUIDv7", () => {
    const parsed = syncMutationSchema.safeParse({
      mutationId: crypto.randomUUID(),
      createdAt: "2026-03-09T12:00:00.000Z",
      kind: "appointment.cancel",
      payload: { id: id(), version: 1 },
    });
    expect(parsed.success).toBe(false);
  });

  test("a reschedule must move something and carry the version it was based on", () => {
    const ok = {
      ...base(),
      kind: "appointment.reschedule",
      payload: { id: id(), version: 2, startsAt: "2026-03-09T13:00:00.000Z" },
    };
    expect(syncMutationSchema.safeParse(ok).success).toBe(true);
    const nothing = {
      ...base(),
      kind: "appointment.reschedule",
      payload: { id: id(), version: 2 },
    };
    expect(syncMutationSchema.safeParse(nothing).success).toBe(false);
    const noVersion = {
      ...base(),
      kind: "appointment.reschedule",
      payload: { id: id(), startsAt: "2026-03-09T13:00:00.000Z" },
    };
    expect(syncMutationSchema.safeParse(noVersion).success).toBe(false);
  });

  test("set_status only offers outcomes (cancel has its own kind)", () => {
    const status = (value: string) =>
      syncMutationSchema.safeParse({
        ...base(),
        kind: "appointment.set_status",
        payload: { id: id(), version: 1, status: value },
      }).success;
    expect(status("completed")).toBe(true);
    expect(status("no_show")).toBe(true);
    expect(status("cancelled")).toBe(false);
    expect(status("booked")).toBe(false);
  });

  test("client and last-writer-wins kinds parse", () => {
    const kinds = [
      { kind: "client.create", payload: { id: id(), name: "Lucia", notes: "n" } },
      { kind: "client.update", payload: { id: id(), notes: "vip" } },
      {
        kind: "time_off.create",
        payload: {
          id: id(),
          staffId: id(),
          startsAt: "2026-03-09T12:00:00.000Z",
          endsAt: "2026-03-09T14:00:00.000Z",
        },
      },
      { kind: "time_off.update", payload: { id: id(), staffId: id(), reason: "x" } },
      { kind: "time_off.delete", payload: { id: id(), staffId: id() } },
      { kind: "service.update", payload: { id: id(), priceCents: 5 } },
      { kind: "staff.update", payload: { id: id(), active: false } },
      { kind: "settings.update", payload: { minNoticeMinutes: 30 } },
    ];
    for (const k of kinds) {
      const parsed = syncMutationSchema.safeParse({ ...base(), ...k });
      expect(parsed.success, k.kind).toBe(true);
    }
  });

  test("an update with no change is invalid", () => {
    expect(
      syncMutationSchema.safeParse({ ...base(), kind: "client.update", payload: { id: id() } })
        .success,
    ).toBe(false);
  });

  test("unknown kinds are invalid", () => {
    expect(
      syncMutationSchema.safeParse({ ...base(), kind: "client.explode", payload: {} }).success,
    ).toBe(false);
  });
});

describe("push request and response", () => {
  test("the envelope only needs a device id and mutation ids; bodies are validated one by one", () => {
    const parsed = syncPushRequestSchema.safeParse({
      deviceId: "front-desk-1",
      mutations: [{ mutationId: id(), anything: "goes" }],
    });
    expect(parsed.success).toBe(true);
  });

  test("an empty batch, an oversized batch and a missing mutation id are rejected", () => {
    expect(syncPushRequestSchema.safeParse({ deviceId: "d", mutations: [] }).success).toBe(false);
    expect(
      syncPushRequestSchema.safeParse({
        deviceId: "d",
        mutations: Array.from({ length: SYNC_PUSH_MAX_MUTATIONS + 1 }, () => ({
          mutationId: id(),
        })),
      }).success,
    ).toBe(false);
    expect(
      syncPushRequestSchema.safeParse({ deviceId: "d", mutations: [{ nope: true }] }).success,
    ).toBe(false);
  });

  test("results are applied, rejected with a reason code, or retry", () => {
    const m = id();
    for (const result of [
      { mutationId: m, status: "applied", appliedSeq: 12, replayed: false },
      { mutationId: m, status: "applied", appliedSeq: null, replayed: true },
      {
        mutationId: m,
        status: "rejected",
        reason: "slot_taken",
        message: "taken",
        replayed: false,
      },
      { mutationId: m, status: "retry", message: "database unavailable" },
    ]) {
      expect(syncMutationResultSchema.safeParse(result).success).toBe(true);
    }
    expect(
      syncMutationResultSchema.safeParse({
        mutationId: m,
        status: "rejected",
        reason: "nope",
        message: "",
        replayed: false,
      }).success,
    ).toBe(false);
    expect(syncPushResponseSchema.safeParse({ results: [], headSeq: 3 }).success).toBe(true);
  });

  test("every documented reject reason is accepted", () => {
    for (const reason of [
      "slot_taken",
      "slot_unavailable",
      "forbidden",
      "invalid",
      "conflict",
      "not_found",
      "invalid_state",
    ]) {
      const parsed = syncMutationResultSchema.safeParse({
        mutationId: id(),
        status: "rejected",
        reason,
        message: "m",
        replayed: false,
      });
      expect(parsed.success, reason).toBe(true);
    }
  });
});

describe("pull query and response", () => {
  test("defaults and bounds", () => {
    expect(syncPullQuerySchema.parse({})).toEqual({ since: 0, limit: SYNC_PULL_LIMIT_DEFAULT });
    expect(syncPullQuerySchema.parse({ since: "42", limit: "10" })).toEqual({
      since: 42,
      limit: 10,
    });
    expect(syncPullQuerySchema.safeParse({ limit: SYNC_PULL_LIMIT_MAX + 1 }).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({ since: -1 }).success).toBe(false);
    expect(syncPullQuerySchema.safeParse({ since: "abc" }).success).toBe(false);
  });

  test("tombstones carry no data, upserts carry the entity", () => {
    const tombstone = { seq: 5, entity: "client", id: id(), op: "delete", data: null };
    expect(syncChangeSchema.safeParse(tombstone).success).toBe(true);
    const upsert = {
      seq: 6,
      entity: "client",
      id: id(),
      op: "upsert",
      data: {
        id: id(),
        name: "Lucia",
        phone: null,
        email: null,
        notes: null,
        createdAt: "2026-03-09T12:00:00.000Z",
        updatedAt: "2026-03-09T12:00:00.000Z",
      },
    };
    expect(syncChangeSchema.safeParse(upsert).success).toBe(true);
    expect(syncChangeSchema.safeParse({ ...upsert, data: null }).success).toBe(false);
    expect(syncChangeSchema.safeParse({ ...upsert, data: { nope: 1 } }).success).toBe(false);
  });

  test("a pull response has changes, a cursor and hasMore", () => {
    expect(
      syncPullResponseSchema.safeParse({ changes: [], nextCursor: 0, hasMore: false, headSeq: 0 })
        .success,
    ).toBe(true);
  });
});
