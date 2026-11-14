import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase("db_verify_staff");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
});

test("migration 0007 verifies existing owners and staff and leaves clients alone", async () => {
  await t.db.execute(sql`
    insert into "user" (id, name, email, role, email_verified) values
      ('u-owner', 'O', 'o@example.com', 'owner', false),
      ('u-staff', 'S', 's@example.com', 'staff', false),
      ('u-client', 'C', 'c@example.com', 'client', false)
  `);
  const file = new URL("../drizzle/0007_verify_existing_staff.sql", import.meta.url);
  await t.db.execute(sql.raw(readFileSync(file, "utf8")));
  const rows = await t.db.execute<{ id: string; email_verified: boolean }>(
    sql`select id, email_verified from "user" order by id`,
  );
  expect(Object.fromEntries(rows.map((r) => [r.id, r.email_verified]))).toEqual({
    "u-client": false,
    "u-owner": true,
    "u-staff": true,
  });
});
