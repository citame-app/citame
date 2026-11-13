import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { createDb, type Database, DEFAULT_DATABASE_URL } from "./client";
import { runMigrations } from "./migrate";

export interface TestDatabase {
  db: Database;
  url: string;
  /** Truncates every application table; call from `beforeEach`. */
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Creates (if needed) and migrates a dedicated `sob_test_<suffix>` database on the
 * server pointed to by DATABASE_URL, and returns a handle to it. Suffixes keep
 * packages that run in parallel under Turborepo from truncating each other's data.
 * Fails loudly when Postgres is unreachable: integration tests never skip silently.
 */
export async function createTestDatabase(suffix: string): Promise<TestDatabase> {
  if (!/^[a-z0-9_]+$/.test(suffix)) throw new Error(`Invalid test database suffix: ${suffix}`);
  const adminUrl = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const testName = `sob_test_${suffix}`;

  const admin = new SQL(adminUrl.toString());
  try {
    const existing = await admin`select 1 from pg_database where datname = ${testName}`;
    if (existing.length === 0) await admin.unsafe(`create database "${testName}"`);
  } catch (error) {
    throw new Error(
      `Integration tests need Postgres at ${adminUrl.host} but it is unreachable ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        "Start it with `docker compose up -d --wait postgres` or set DATABASE_URL.",
    );
  } finally {
    await admin.close();
  }

  const testUrl = new URL(adminUrl.toString());
  testUrl.pathname = `/${testName}`;
  const { db, close } = createDb(testUrl.toString());
  await runMigrations(db);

  return {
    db,
    url: testUrl.toString(),
    reset: async () => {
      const tables = await db.execute<{ tablename: string }>(
        sql`select tablename from pg_tables where schemaname = 'public'`,
      );
      if (tables.length === 0) return;
      const list = tables.map((row) => `"${row.tablename}"`).join(", ");
      await db.execute(sql.raw(`truncate table ${list} restart identity cascade`));
    },
    close: async () => {
      await close();
    },
  };
}
