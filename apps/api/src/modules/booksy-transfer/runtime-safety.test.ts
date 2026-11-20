import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  assertNotBooksyReviewDatabase,
  assertOperationalDatabase,
  createDb,
  DEFAULT_DATABASE_URL,
} from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import { rehearseRestoredSchedule } from "./schedule-check";

test("a private import name is rejected before making a database connection", () => {
  for (const kind of ["candidate", "rehearsal", "restorecheck", "desktop_test"]) {
    expect(() =>
      assertNotBooksyReviewDatabase(`postgres://127.0.0.1/sob_booksy_${kind}_20261117`),
    ).toThrow("cannot run");
  }
});

test("operational entry points reject review archives even under an ordinary database name", async () => {
  const data = await createTestDatabase("booksy_runtime_guard");
  try {
    expect(() => assertNotBooksyReviewDatabase(data.url)).not.toThrow();
    await expect(assertOperationalDatabase(data.db)).resolves.toBeUndefined();
    await expect(rehearseRestoredSchedule(data.db, "2026-11-18")).rejects.toThrow(
      "Schedule rehearsal requires a private restore",
    );
    // Behaves like a full pg_restore of a private archive into an ordinary database name.
    await data.db.execute(sql`create schema booksy_rehearsal`);
    await expect(assertOperationalDatabase(data.db)).rejects.toThrow("private Booksy review");
    const entrypoints = [
      ["../../index.ts"],
      ["../../worker.ts"],
      ["../../../../../packages/db/src/scripts/migrate.ts"],
      ["../../../../../packages/db/src/scripts/migrate.ts", "--online"],
      ["../../../../../packages/db/src/scripts/seed.ts"],
    ] as const;
    for (const [entry, ...args] of entrypoints) {
      const path = fileURLToPath(new URL(entry, import.meta.url));
      const child = Bun.spawn([process.execPath, path, ...args], {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: data.url,
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
          VALKEY_URL: "redis://127.0.0.1:1",
          AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(5000),
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(error).toContain("private Booksy review archive");
      expect(output).toBe("");
    }
  } finally {
    try {
      await data.db.execute(sql`drop schema if exists booksy_rehearsal`);
    } finally {
      await data.close();
    }
  }
});

test("the production API and worker refuse an installation behind the release ledger", async () => {
  const suffix = `prod_boot_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const admin = createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  let data: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    data = await createTestDatabase(suffix);
    const [missing] = await data.db.execute<{ id: number }>(sql`
      delete from drizzle.__drizzle_migrations
      where id = (select id from drizzle.__drizzle_migrations order by created_at desc limit 1)
      returning id
    `);
    if (!missing) throw new Error("Expected a migrated fixture database");
    for (const entry of ["../../index.ts", "../../worker.ts"]) {
      const path = fileURLToPath(new URL(entry, import.meta.url));
      const child = Bun.spawn([process.execPath, "--no-env-file", path], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          DATABASE_URL: data.url,
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
          VALKEY_URL: "redis://127.0.0.1:1",
          AUTH_REQUIRE_EMAIL_VERIFICATION: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
        signal: AbortSignal.timeout(5000),
      });
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code).toBe(1);
      expect(error).toBe("");
      expect(JSON.parse(output)).toMatchObject({
        level: "error",
        msg: "database migration check failed",
        reason: "PostgreSQL migration ledger length differs from the release",
      });
    }
  } finally {
    try {
      await data?.close();
      await admin.db.execute(
        sql`drop database if exists ${sql.identifier(`sob_test_${suffix}`)} with (force)`,
      );
    } finally {
      await admin.close();
    }
  }
}, 25_000);
