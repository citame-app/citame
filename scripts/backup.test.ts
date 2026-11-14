import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { seedSampleData } from "../packages/db/src/seed";
import { createTestDatabase, type TestDatabase } from "../packages/db/src/testing";

/**
 * Backs up a seeded database with the real script, restores it into a brand-new database with
 * the real script and compares the row count of every table. Needs Postgres from compose.
 */
let source: TestDatabase;
let dir: string;
const restoredName = `sob_test_restored_${Date.now()}`;

beforeAll(async () => {
  source = await createTestDatabase("backup_src");
  await source.reset();
  await seedSampleData(source.db);
  dir = mkdtempSync(join(tmpdir(), "sob-backup-"));
});
afterAll(async () => {
  const admin = new SQL(source.url.replace(/\/[^/]+$/, "/postgres"));
  await admin.unsafe(`drop database if exists "${restoredName}" with (force)`);
  await admin.close();
  await source.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (cmd: string[], env: Record<string, string>) =>
  Bun.spawnSync(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });

async function counts(url: string) {
  const db = new SQL(url);
  const rows = await db`
    select table_name,
      (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n
    from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`;
  await db.close();
  return Object.fromEntries(
    rows.map((r: { table_name: string; n: number }) => [r.table_name, r.n]),
  );
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

  const before = await counts(source.url);
  const after = await counts(target);
  expect(Object.values(before).reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
  expect(after).toEqual(before);
});

test("restore refuses a corrupted dump and a non-empty target", async () => {
  const dump = join(dir, "bad.dump");
  expect(run(["bash", "scripts/backup.sh", dump], { DATABASE_URL: source.url }).exitCode).toBe(0);
  await Bun.write(dump, `${await Bun.file(dump).text()}tampered`);
  const target = source.url.replace(/\/[^/]+$/, `/${restoredName}_x`);
  const bad = run(["bash", "scripts/restore.sh", dump, target], {});
  expect(bad.exitCode).not.toBe(0);
  expect(bad.stderr.toString()).toContain("checksum");

  const occupied = run(["bash", "scripts/restore.sh", dump, source.url], {});
  expect(occupied.exitCode).not.toBe(0);
});
