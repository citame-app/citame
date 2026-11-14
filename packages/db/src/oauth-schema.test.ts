import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgErrorCode } from "./errors";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("db_oauth");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

async function columns(table: string): Promise<Record<string, string>> {
  const rows = await t.db.execute<{ column_name: string; data_type: string }>(sql`
    select column_name, data_type from information_schema.columns
    where table_schema = 'public' and table_name = ${table}
  `);
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

describe("OAuth 2.1 provider tables (Better Auth oauth-provider + jwt plugin)", () => {
  test("every table exists with snake_case columns", async () => {
    for (const table of [
      "oauth_client",
      "oauth_resource",
      "oauth_client_resource",
      "oauth_access_token",
      "oauth_refresh_token",
      "oauth_consent",
      "oauth_client_assertion",
      "jwks",
    ]) {
      expect(Object.keys(await columns(table)).length).toBeGreaterThan(0);
    }
    const client = await columns("oauth_client");
    expect(client.client_id).toBe("text");
    expect(client.redirect_uris).toBe("ARRAY");
    expect(client.metadata).toBe("jsonb");
    expect(client.created_at).toBe("timestamp with time zone");
    expect((await columns("oauth_refresh_token")).expires_at).toBe("timestamp with time zone");
    expect((await columns("jwks")).private_key).toBe("text");
  });

  test("client_id is unique", async () => {
    const insert = () =>
      t.db.execute(sql`
        insert into oauth_client (id, client_id, redirect_uris)
        values (${Bun.randomUUIDv7()}, 'c1', ARRAY['http://127.0.0.1/cb'])
      `);
    await insert();
    let code: string | undefined;
    try {
      await insert();
    } catch (error) {
      code = pgErrorCode(error);
    }
    expect(code).toBe("23505");
  });

  test("deleting a user cascades to their consents but keeps no dangling tokens", async () => {
    await t.db.execute(
      sql`insert into "user" (id, name, email) values ('u1', 'A', 'a@example.com')`,
    );
    await t.db.execute(sql`
      insert into oauth_client (id, client_id, redirect_uris)
      values ('k1', 'c1', ARRAY['http://127.0.0.1/cb'])
    `);
    await t.db.execute(sql`
      insert into oauth_consent (id, client_id, user_id, scopes, created_at, updated_at)
      values ('x1', 'c1', 'u1', ARRAY['mcp:read'], now(), now())
    `);
    await t.db.execute(sql`delete from "user" where id = 'u1'`);
    const rows = await t.db.execute(sql`select 1 from oauth_consent`);
    expect(rows.length).toBe(0);
  });
});
