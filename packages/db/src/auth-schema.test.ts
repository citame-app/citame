import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgErrorCode } from "./errors";
import { clientProfile, staffProfile } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("db_auth");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function columns(table: string): Promise<string[]> {
  const rows = await t.db.execute<{ column_name: string }>(sql`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
    order by column_name
  `);
  return rows.map((r) => r.column_name);
}

async function insertUser(id: string) {
  await t.db.execute(sql`
    insert into "user" (id, name, email, role) values (${id}, 'Test', ${`${id}@example.com`}, 'client')
  `);
}

describe("Better Auth tables", () => {
  test("user, session, account and verification exist with the expected columns", async () => {
    expect(await columns("user")).toEqual(
      ["created_at", "email", "email_verified", "id", "image", "name", "role", "updated_at"].sort(),
    );
    expect((await columns("session")).sort()).toEqual(
      [
        "created_at",
        "expires_at",
        "id",
        "ip_address",
        "token",
        "updated_at",
        "user_agent",
        "user_id",
      ].sort(),
    );
    expect((await columns("account")).length).toBeGreaterThan(0);
    expect((await columns("verification")).length).toBeGreaterThan(0);
  });

  test("user.role defaults to client", async () => {
    await t.db.execute(
      sql`insert into "user" (id, name, email) values ('u1', 'A', 'a@example.com')`,
    );
    const rows = await t.db.execute<{ role: string }>(sql`select role from "user" where id = 'u1'`);
    expect(rows[0]?.role).toBe("client");
  });

  test("user.role only accepts owner, staff or client", async () => {
    const error = await t.db
      .execute(
        sql`insert into "user" (id, name, email, role) values ('u1', 'A', 'a@example.com', 'admin')`,
      )
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23514");
  });
});

describe("profile links", () => {
  test("staff_profile.user_id is a real foreign key", async () => {
    const error = await t.db
      .insert(staffProfile)
      .values({ displayName: "Ana", userId: "missing-user" })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23503");

    await insertUser("u1");
    const [row] = await t.db
      .insert(staffProfile)
      .values({ displayName: "Ana", userId: "u1" })
      .returning();
    expect(row?.userId).toBe("u1");
  });

  test("client_profile.user_id is a real foreign key", async () => {
    const error = await t.db
      .insert(clientProfile)
      .values({ name: "Lucia", userId: "missing-user" })
      .catch((e: unknown) => e);
    expect(pgErrorCode(error)).toBe("23503");
  });

  test("a user links to at most one staff profile and one client profile", async () => {
    await insertUser("u1");
    await t.db.insert(staffProfile).values({ displayName: "Ana", userId: "u1" });
    const staffAgain = await t.db
      .insert(staffProfile)
      .values({ displayName: "Ana 2", userId: "u1" })
      .catch((e: unknown) => e);
    expect(pgErrorCode(staffAgain)).toBe("23505");

    await t.db.insert(clientProfile).values({ name: "Lucia", userId: "u1" });
    const clientAgain = await t.db
      .insert(clientProfile)
      .values({ name: "Lucia 2", userId: "u1" })
      .catch((e: unknown) => e);
    expect(pgErrorCode(clientAgain)).toBe("23505");
  });

  test("profiles without a user stay valid (walk-in clients, unlinked staff)", async () => {
    await t.db.insert(clientProfile).values({ name: "Walk-in" });
    await t.db.insert(clientProfile).values({ name: "Walk-in 2" });
    await t.db.insert(staffProfile).values({ displayName: "Unlinked" });
  });
});

describe("audit_log", () => {
  test("has the expected columns", async () => {
    expect(await columns("audit_log")).toEqual(
      ["action", "actor_user_id", "created_at", "entity", "entity_id", "id", "metadata"].sort(),
    );
  });

  test("stores jsonb metadata and keeps rows when the actor user is deleted", async () => {
    await insertUser("u1");
    await t.db.execute(sql`
      insert into audit_log (id, actor_user_id, action, entity, entity_id, metadata)
      values (${Bun.randomUUIDv7()}, 'u1', 'appointment.create', 'appointment', 'a1', '{"k": 1}'::jsonb)
    `);
    await t.db.execute(sql`delete from "user" where id = 'u1'`);
    const rows = await t.db.execute<{ actor_user_id: string | null; metadata: { k: number } }>(
      sql`select actor_user_id, metadata from audit_log`,
    );
    expect(rows[0]?.actor_user_id).toBeNull();
    expect(rows[0]?.metadata).toEqual({ k: 1 });
  });
});
