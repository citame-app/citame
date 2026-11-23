import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { seedSampleData } from "../packages/db/src/seed";
import { createTestDatabase, type TestDatabase } from "../packages/db/src/testing";

/**
 * Backs up a seeded database with the real script, restores it into a brand-new database with
 * the real script and compares the contents of every table. Needs Postgres from compose.
 */
let source: TestDatabase;
let dir: string;
const runId = Bun.randomUUIDv7().replaceAll("-", "");
const sourceSuffix = `backup_${runId}`;
const restoredName = `sob_test_restored_${runId}`;
const truncatedName = `${restoredName}_truncated`;
const restrictedName = `${restoredName}_restricted`;
const invalidArchiveName = `${restoredName}_invalid`;
const restoreRole = `sob_restore_${runId}`;

beforeAll(async () => {
  source = await createTestDatabase(sourceSuffix);
  await source.reset();
  await seedSampleData(source.db);
  dir = mkdtempSync(join(tmpdir(), "sob-backup-"));
}, 60_000);
afterAll(async () => {
  const admin = new SQL(source.url.replace(/\/[^/]+$/, "/postgres"));
  try {
    await source.close();
    for (const name of [
      `sob_test_${sourceSuffix}`,
      restoredName,
      truncatedName,
      restrictedName,
      invalidArchiveName,
    ]) {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    }
    await admin.unsafe(`drop role if exists "${restoreRole}"`);
  } finally {
    await admin.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

const run = (cmd: string[], env: Record<string, string>) =>
  Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

async function fingerprint(url: string) {
  const db = new SQL(url);
  try {
    const tables: { table_schema: string; table_name: string }[] = await db`
      select table_schema, table_name
      from information_schema.tables
      where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE'
      order by 1, 2`;
    const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const result: Record<string, { rows: number; sha256: string }> = {};
    for (const { table_schema, table_name } of tables) {
      const name = `${quote(table_schema)}.${quote(table_name)}`;
      const [row] = await db.unsafe(`
        select count(*)::int as rows,
          encode(sha256(convert_to(coalesce(
            string_agg(to_jsonb(t)::text, chr(10) order by to_jsonb(t)::text collate "C"), ''
          ), 'UTF8')), 'hex') as sha256
        from ${name} t
      `);
      if (!row) throw new Error(`Missing fingerprint for ${name}`);
      result[name] = row;
    }
    return result;
  } finally {
    await db.close();
  }
}

test("backup then restore into a fresh database reproduces every table", async () => {
  const dump = join(dir, "sob.dump");
  const backup = run(["bash", "scripts/backup.sh", dump], { DATABASE_URL: source.url });
  expect(backup.stderr.toString() + backup.stdout.toString()).toContain("backup written");
  expect(backup.exitCode).toBe(0);
  // A checksum file travels with the dump so corruption is detectable before a restore.
  expect(readFileSync(`${dump}.sha256`, "utf8")).toMatch(/^[0-9a-f]{64}\s/);

  const target = source.url.replace(/\/[^/]+$/, `/${restoredName}`);
  const restore = run(["bash", "scripts/restore.sh", dump, target], {});
  expect(restore.exitCode, restore.stderr.toString()).toBe(0);

  const before = await fingerprint(source.url);
  const after = await fingerprint(target);
  expect(Object.values(before).reduce((total, table) => total + table.rows, 0)).toBeGreaterThan(10);
  expect(after).toEqual(before);

  const recovered = new SQL(target);
  const owner = new SQL(source.url);
  const reader = `${restoreRole}_reader`;
  try {
    await owner.unsafe(`create role "${reader}" nologin`);
    const checkPermission = recovered.begin(async (tx) => {
      await tx.unsafe(`set local role "${reader}"`);
      await tx`select next_number from public.inventory_numbering_status('orders')`;
    });
    await expect(checkPermission).rejects.toMatchObject({ errno: "42501" });
    await expect(
      recovered.begin(async (tx) => {
        await tx.unsafe(`set local role "${reader}"`);
        await tx`select changed from public.inventory_numbering_advance('orders', 1, 20)`;
      }),
    ).rejects.toMatchObject({ errno: "42501" });
    const restoredOrderNumber =
      await recovered`select next_number from public.inventory_numbering_status('orders')`;
    expect(restoredOrderNumber).toEqual([{ next_number: 1 }]);
    const rollback = new Error("restore test rolls back the sequence change");
    await expect(
      recovered.begin(async (tx) => {
        await tx.unsafe(
          `grant execute on function public.inventory_numbering_status(text) to "${reader}"`,
        );
        await tx.unsafe(
          `grant execute on function public.inventory_numbering_advance(text,integer,integer) to "${reader}"`,
        );
        await tx.unsafe(`set local role "${reader}"`);
        expect(
          await tx`select next_number from public.inventory_numbering_advance('orders', 1, 20)`,
        ).toEqual([{ next_number: 20 }]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await recovered.close();
    await owner.unsafe(`drop role if exists "${reader}"`);
    await owner.close();
  }
}, 60_000);

test("restore refuses a corrupted dump and a non-empty target", async () => {
  const dump = join(dir, "bad.dump");
  expect(run(["bash", "scripts/backup.sh", dump], { DATABASE_URL: source.url }).exitCode).toBe(0);
  await Bun.write(dump, `${await Bun.file(dump).text()}tampered`);
  const target = source.url.replace(/\/[^/]+$/, `/${restoredName}_x`);
  const bad = run(["bash", "scripts/restore.sh", dump, target], {});
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr.toString()).toContain("checksum");

  // Use an intact dump here, otherwise checksum rejection masks the non-empty-target guard.
  const intact = join(dir, "intact.dump");
  expect(run(["bash", "scripts/backup.sh", intact], { DATABASE_URL: source.url }).exitCode).toBe(0);
  const occupied = run(["bash", "scripts/restore.sh", intact, source.url], {});
  expect(occupied.exitCode).not.toBe(0);
  expect(occupied.stderr.toString()).toContain("already has");

  rmSync(`${intact}.sha256`);
  const unverified = run(["bash", "scripts/restore.sh", intact, target], {});
  expect(unverified.exitCode).not.toBe(0);
  expect(unverified.stderr.toString()).toContain("missing checksum");
}, 60_000);

test("a matching checksum does not create a database for an unreadable archive", async () => {
  const dump = join(dir, "invalid-archive.dump");
  const contents = "This is not a PostgreSQL backup.";
  const checksum = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
  await Bun.write(dump, contents);
  await Bun.write(`${dump}.sha256`, `${checksum}  invalid-archive.dump\n`);
  const target = new URL(source.url);
  target.pathname = `/${invalidArchiveName}`;
  const restored = run(["bash", "scripts/restore.sh", dump, target.href], {});
  expect(restored.exitCode).not.toBe(0);
  expect(restored.stderr.toString()).toContain("archive table of contents");
  target.pathname = "/postgres";
  const admin = new SQL(target.href);
  try {
    const result = await admin`
      select exists (select 1 from pg_database where datname = ${invalidArchiveName}) as present
    `;
    expect(result).toEqual([{ present: false }]);
  } finally {
    await admin.close();
  }
});

test("restore refuses hidden tables and standalone objects in the target", async () => {
  const dump = join(dir, "restricted.dump");
  expect(run(["bash", "scripts/backup.sh", dump], { DATABASE_URL: source.url }).exitCode).toBe(0);

  const target = new URL(source.url);
  target.pathname = `/${restrictedName}`;
  const admin = new SQL(source.url);
  const setup = new SQL(target.toString());
  const password = Bun.randomUUIDv7();
  const restrictedUrl = new URL(target);
  restrictedUrl.username = restoreRole;
  restrictedUrl.password = password;
  const restricted = new SQL(restrictedUrl.toString());
  try {
    await admin.unsafe(`create role "${restoreRole}" login password '${password}'`);
    await admin.unsafe(`create database "${restrictedName}"`);
    await setup`create table private_record as select 'keep'::text as value`;
    await setup.unsafe(`grant create on schema public to "${restoreRole}"`);
    expect(
      await restricted`
      select table_name from information_schema.tables where table_schema = 'public'
    `,
    ).toHaveLength(0);

    const expectOccupied = () => {
      const result = run(["bash", "scripts/restore.sh", dump, restrictedUrl.toString()], {
        FORCE: "0",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("already has database objects");
    };
    expectOccupied();
    expect(await setup`select value from private_record`).toEqual([{ value: "keep" }]);

    await setup`drop table private_record`;
    await setup`create collation public.existing_sort from pg_catalog."C"`;
    expectOccupied();
  } finally {
    await Promise.all([restricted.close(), setup.close(), admin.close()]);
  }
}, 60_000);

test("backup never replaces an existing archive or follows its checksum symlink", async () => {
  const dump = join(dir, "protected.dump");
  await Bun.write(dump, "existing archive");
  await Bun.write(`${dump}.sha256`, "existing checksum");
  const exists = run(["bash", "scripts/backup.sh", dump], { DATABASE_URL: source.url });
  expect(exists.exitCode).not.toBe(0);
  expect(await Bun.file(dump).text()).toBe("existing archive");
  expect(await Bun.file(`${dump}.sha256`).text()).toBe("existing checksum");

  const linked = join(dir, "linked.dump");
  symlinkSync(dump, `${linked}.sha256`);
  const refused = run(["bash", "scripts/backup.sh", linked], { DATABASE_URL: source.url });
  expect(refused.exitCode).not.toBe(0);
  expect(await Bun.file(dump).text()).toBe("existing archive");
  expect(await Bun.file(linked).exists()).toBe(false);
}, 60_000);

test("concurrent backups to the same destination publish one consistent private pair", async () => {
  const dump = join(dir, "concurrent.dump");
  const start = () =>
    Bun.spawn(["bash", "scripts/backup.sh", dump], {
      env: { ...process.env, DATABASE_URL: source.url },
      stdout: "ignore",
      stderr: "ignore",
    });
  const results = await Promise.all([start().exited, start().exited]);
  expect(results.filter((code) => code === 0)).toHaveLength(1);
  const archive = Bun.file(dump);
  const checksum = Bun.file(`${dump}.sha256`);
  expect((await archive.stat()).mode & 0o777).toBe(0o600);
  expect((await checksum.stat()).mode & 0o777).toBe(0o600);
  const digest = new Bun.CryptoHasher("sha256").update(await archive.arrayBuffer()).digest("hex");
  expect(await checksum.text()).toBe(`${digest}  concurrent.dump\n`);
}, 60_000);

test("a failed dump leaves no published files or staging directory", () => {
  const name = "failed.dump";
  const rejected = run(["bash", "scripts/backup.sh", join(dir, name)], {
    DATABASE_URL: source.url.replace(/\/[^/]+$/, `/${restoredName}_missing`),
  });
  expect(rejected.exitCode).not.toBe(0);
  expect(readdirSync(dir).filter((entry) => entry.startsWith(name))).toEqual([]);
});

test("an explicitly empty Docker container cannot fall back to the default Compose project", () => {
  const rejected = run(["bash", "scripts/backup.sh", join(dir, "wrong-target.dump")], {
    DATABASE_URL: "postgres://sob@localhost:5432/sob",
    PG_MODE: "docker",
    PG_CONTAINER: "",
  });
  expect(rejected.exitCode).not.toBe(0);
  expect(rejected.stderr.toString()).toContain("PG_CONTAINER is set but empty");
});

test("the native client and administrative connection retain the URL's PostgreSQL settings", () => {
  const checked = run(
    [
      "bash",
      "-c",
      `source scripts/lib.sh
      inspect_connection() { printf '%s\\n' "$PGPASSWORD" "$@"; }
      database_url='postgres://owner:p%40ss@db.example.invalid/salon?sslmode=verify-full&application_name=a+b'
      pg_tool inspect_connection "$database_url" --single-transaction
      pg_tool inspect_connection "$(admin_url "$database_url")"`,
    ],
    { PG_MODE: "native" },
  );
  expect(checked.exitCode, checked.stderr.toString()).toBe(0);
  expect(checked.stdout.toString().trimEnd().split("\n")).toEqual([
    "p@ss",
    "-d",
    "postgres://owner@db.example.invalid/salon?sslmode=verify-full&application_name=a+b",
    "--single-transaction",
    "p@ss",
    "-d",
    "postgres://owner@db.example.invalid/postgres?sslmode=verify-full&application_name=a+b",
  ]);
});

test("Docker fallback never substitutes its socket for a different or configured endpoint", () => {
  const dispatch = (url: string, mode = "auto") =>
    run(
      [
        "bash",
        "-c",
        `source scripts/lib.sh
        docker() { printf 'docker %s\\n' "$*"; }
        pg_tool citame_missing_postgres_client "$1"`,
        "backup-test",
        url,
      ],
      { PG_MODE: mode, PG_CONTAINER: "synthetic-postgres" },
    );
  expect(dispatch("postgres://owner@localhost/salon").stdout.toString()).toContain("docker");
  for (const url of [
    "postgres://owner@remote.example.invalid/salon",
    "postgres://owner@localhost:5433/salon",
    "postgres://owner@localhost/salon?host=remote.example.invalid",
    "postgres://owner@localhost/salon?sslmode=verify-full",
  ]) {
    for (const mode of ["auto", "docker"]) {
      const checked = dispatch(url, mode);
      expect(checked.exitCode).not.toBe(0);
      expect(checked.stdout.toString()).toBe("");
      expect(checked.stderr.toString()).toContain("native PostgreSQL");
    }
  }
});

test("a truncated archive rolls back even with a matching checksum", async () => {
  // Add enough incompressible table data to put the cut inside table data, past the archive TOC.
  const db = new SQL(source.url);
  try {
    await db`
      create table backup_incompressible as
        select n, string_agg(md5(n::text || ':' || block::text), '' order by block) as value
        from generate_series(1, 32) as n cross join generate_series(1, 2048) as block
        group by n
    `;
  } finally {
    await db.close();
  }
  const full = join(dir, "full-for-truncation.dump");
  const dump = join(dir, "truncated.dump");
  expect(run(["bash", "scripts/backup.sh", full], { DATABASE_URL: source.url }).exitCode).toBe(0);
  const archive = new Uint8Array(await Bun.file(full).arrayBuffer());
  // PostgreSQL 18 can append optimizer statistics after all the table data.
  const truncated = archive.subarray(0, Math.floor(archive.length * 0.35));
  await Bun.write(dump, truncated);
  expect((await Bun.file(dump).stat()).size).toBe(truncated.length);
  const checksum = new Bun.CryptoHasher("sha256").update(truncated).digest("hex");
  await Bun.write(`${dump}.sha256`, `${checksum}  truncated.dump\n`);
  const target = source.url.replace(/\/[^/]+$/, `/${truncatedName}`);
  const restored = run(["bash", "scripts/restore.sh", dump, target], {});
  expect(restored.exitCode, restored.stderr.toString() + restored.stdout.toString()).not.toBe(0);
  expect(await fingerprint(target)).toEqual({});
}, 60_000);
