import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { auditLog, user } from "@sob/db";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { eq } from "drizzle-orm";
import { recordAudit, redactMetadata } from "./audit";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("api_audit");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

describe("redactMetadata", () => {
  test("drops secrets at any depth and keeps everything else", () => {
    const redacted = redactMetadata({
      staffId: "s1",
      password: "hunter2",
      nested: { accessToken: "abc", keep: 1, list: [{ secret: "x", ok: true }] },
      Authorization: "Bearer abc",
      cookie: "a=b",
      newPassword: "p",
      session_token: "t",
    });
    expect(redacted).toEqual({ staffId: "s1", nested: { keep: 1, list: [{ ok: true }] } });
  });

  test("leaves primitives and null values alone", () => {
    expect(redactMetadata({ a: null, b: "x", c: 3, d: false })).toEqual({
      a: null,
      b: "x",
      c: 3,
      d: false,
    });
  });
});

describe("recordAudit", () => {
  test("writes a row with a UUIDv7 id and the given fields", async () => {
    await t.db.insert(user).values({ id: "u1", name: "A", email: "a@example.com" });
    await recordAudit(t.db, {
      actorUserId: "u1",
      action: "appointment.create",
      entity: "appointment",
      entityId: "appt-1",
      metadata: { staffId: "s1" },
    });
    const rows = await t.db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: "u1",
      action: "appointment.create",
      entity: "appointment",
      entityId: "appt-1",
      metadata: { staffId: "s1" },
    });
    expect(rows[0]?.id.split("-")[2]?.[0]).toBe("7");
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  test("never persists secrets passed in metadata", async () => {
    await recordAudit(t.db, {
      actorUserId: null,
      action: "staff.create",
      entity: "user",
      entityId: "u9",
      metadata: { email: "ana@example.com", password: "hunter2" },
    });
    const [row] = await t.db.select().from(auditLog).where(eq(auditLog.entityId, "u9"));
    expect(row?.actorUserId).toBeNull();
    expect(row?.metadata).toEqual({ email: "ana@example.com" });
    expect(JSON.stringify(row)).not.toContain("hunter2");
  });

  test("participates in the caller's transaction", async () => {
    await t.db
      .transaction(async (tx) => {
        await recordAudit(tx, {
          actorUserId: null,
          action: "x.y",
          entity: "x",
          entityId: "1",
        });
        throw new Error("rollback");
      })
      .catch(() => {});
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });
});
