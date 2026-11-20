import { expect, test } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb, DEFAULT_DATABASE_URL, NO_DB_TIMEOUTS } from "./client";
import { migrationsFolder, runMigrations, verifyMigrationLedger } from "./migrate";

test("database scripts check the actual database selected by PGDATABASE", async () => {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const database = `sob_booksy_candidate_test_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const admin = createDb(url.href, NO_DB_TIMEOUTS);
  try {
    await admin.db.execute(sql`create database ${sql.identifier(database)}`);
    for (const script of ["migrate", "seed"]) {
      const path = fileURLToPath(new URL(`./scripts/${script}.ts`, import.meta.url));
      const child = Bun.spawn([process.execPath, path], {
        env: { ...process.env, DATABASE_URL: url.href, PGDATABASE: database },
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
      expect(output).toBe("");
      expect(error).toContain("private Booksy import database");
    }
  } finally {
    try {
      await admin.db.execute(sql`drop database if exists ${sql.identifier(database)}`);
    } finally {
      await admin.close();
    }
  }
}, 25_000);

test("operational migration leaves a review database untouched while rehearsal can migrate it", async () => {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const database = `sob_test_migrate_review_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const admin = createDb(url.href, NO_DB_TIMEOUTS);
  try {
    await admin.db.execute(sql`create database ${sql.identifier(database)}`);
    url.pathname = `/${database}`;
    const target = createDb(url.href, NO_DB_TIMEOUTS);
    try {
      await target.db.execute(sql`create schema booksy_rehearsal`);
      for (const online of [false, true]) {
        await expect(runMigrations(target.db, { online })).rejects.toThrow(
          "private Booksy review archive",
        );
      }
      const [before] = await target.db.execute<{ journal: string | null }>(
        sql`select to_regclass('drizzle.__drizzle_migrations') as journal`,
      );
      expect(before?.journal).toBeNull();

      await runMigrations(target.db, { allowReviewDatabase: true });
      expect((await verifyMigrationLedger(target.db)).applied).toBeGreaterThan(0);
    } finally {
      await target.close();
    }
  } finally {
    try {
      await admin.db.execute(sql`drop database if exists ${sql.identifier(database)}`);
    } finally {
      await admin.close();
    }
  }
}, 25_000);

test("independent migrators wait before reading the journal and apply each migration once", async () => {
  const url = new URL(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const database = `sob_test_migrate_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const admin = createDb(url.href, NO_DB_TIMEOUTS);
  try {
    await admin.db.execute(sql`create database ${sql.identifier(database)}`);
    url.pathname = `/${database}`;
    const options = { ...NO_DB_TIMEOUTS, poolMax: 1 };
    const gate = createDb(url.href, options);
    const left = createDb(url.href, options);
    const right = createDb(url.href, options);
    let attempts: Promise<PromiseSettledResult<void>[]> | undefined;
    let results: PromiseSettledResult<void>[] | undefined;
    try {
      await gate.db.execute(
        sql`select pg_advisory_lock(hashtextextended('sob-schema-migrations-v1', 0))`,
      );
      attempts = Promise.allSettled([runMigrations(left.db), runMigrations(right.db)]);
      let waiting = 0;
      const deadline = Date.now() + 5_000;
      while (waiting < 2 && Date.now() < deadline) {
        const [result] = await gate.db.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())
        `);
        waiting = result!.waiting;
        if (waiting < 2) await Bun.sleep(20);
      }
      expect(waiting).toBe(2);
      const [before] = await gate.db.execute<{ journal: string | null }>(
        sql`select to_regclass('drizzle.__drizzle_migrations') as journal`,
      );
      expect(before?.journal).toBeNull();
    } finally {
      await gate.close();
      results = await attempts;
      await Promise.all([left.close(), right.close()]);
    }
    expect(results).toEqual([
      { status: "fulfilled", value: undefined },
      { status: "fulfilled", value: undefined },
    ]);

    const verification = createDb(url.href, options);
    try {
      const [applied] = await verification.db.execute<{ rows: number; unique: number }>(sql`
        select count(*)::int as rows, count(distinct created_at)::int as unique
        from drizzle.__drizzle_migrations
      `);
      const journal = await Bun.file(join(migrationsFolder, "meta", "_journal.json")).json();
      expect(applied).toEqual({ rows: journal.entries.length, unique: journal.entries.length });
      expect(await verifyMigrationLedger(verification.db)).toMatchObject({
        applied: journal.entries.length,
        headTimestamp: journal.entries.at(-1).when,
        headSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const release = await verifyMigrationLedger(verification.db);
      const newerTimestamp = release.headTimestamp + 1;
      const newerHash = "a".repeat(64);
      await verification.db.execute(sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${newerHash}, ${newerTimestamp})
      `);
      expect(await verifyMigrationLedger(verification.db, { allowNewer: true })).toEqual(release);
      await expect(verifyMigrationLedger(verification.db)).rejects.toThrow("ledger length differs");
      await verification.db.execute(sql`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${newerHash}, ${newerTimestamp})
      `);
      await expect(verifyMigrationLedger(verification.db, { allowNewer: true })).rejects.toThrow(
        "invalid newer entry",
      );
      await verification.db.execute(sql`
        delete from drizzle.__drizzle_migrations where created_at = ${newerTimestamp}
      `);
      await verification.db.execute(sql`
        update drizzle.__drizzle_migrations set hash = 'wrong'
        where created_at = (select min(created_at) from drizzle.__drizzle_migrations)
      `);
      await expect(verifyMigrationLedger(verification.db)).rejects.toThrow(
        "differs from the release",
      );
      await expect(verifyMigrationLedger(verification.db, { allowNewer: true })).rejects.toThrow(
        "differs from the release",
      );
      await expect(runMigrations(verification.db)).rejects.toThrow(
        "PostgreSQL migration ledger differs from the release at entry 1",
      );
    } finally {
      await verification.close();
    }
  } finally {
    try {
      await admin.db.execute(sql`drop database if exists ${sql.identifier(database)}`);
    } finally {
      await admin.close();
    }
  }
}, 25_000);
