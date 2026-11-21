import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import originLedger from "../drizzle/legacy/e5061d7/ledger.json";
import type { Database } from "./client";
import { assertOperationalDatabase } from "./operational-database";

export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const calendarBadgeBackfillTimestamp = 1795057784682;
const inventoryClassificationBackfillTimestamp = 1795242011000;
const booksyPaymentReviewBackfillTimestamp = 1795248805000;

/** Summarize the ordered ledger that a successful migration must leave behind. */
export function getReleaseMigrationLedger(migrations = readMigrationFiles({ migrationsFolder })) {
  const head = migrations.at(-1);
  if (!head) throw new Error("The release has no PostgreSQL migrations");
  const entries = migrations.map(({ folderMillis, hash }) => [folderMillis, hash]);
  return {
    applied: migrations.length,
    headTimestamp: head.folderMillis,
    headSha256: head.hash,
    ledgerSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
  };
}

/** Recovery requires an exact ledger. Older running code may accept a strictly newer suffix. */
export class MigrationLedgerError extends Error {}

function readAppliedLedger(db: Pick<Database, "execute">) {
  return db.execute<{ timestamp: string; hash: string }>(sql`
    select created_at::text as timestamp, hash
    from drizzle.__drizzle_migrations
    order by created_at, id
  `);
}

function assertLedger(
  expected: ReturnType<typeof readMigrationFiles>,
  applied: Awaited<ReturnType<typeof readAppliedLedger>>,
  mode: "exact" | "required" | "before-migration",
) {
  if (
    (mode === "exact" && applied.length !== expected.length) ||
    (mode === "required" && applied.length < expected.length)
  ) {
    throw new MigrationLedgerError("PostgreSQL migration ledger length differs from the release");
  }
  for (const [index, migration] of expected.slice(0, applied.length).entries()) {
    const row = applied[index];
    if (row?.timestamp !== String(migration.folderMillis) || row.hash !== migration.hash)
      throw new MigrationLedgerError(
        `PostgreSQL migration ledger differs from the release at entry ${index + 1}`,
      );
  }
  let previous = expected.at(-1)?.folderMillis ?? 0;
  for (const [index, row] of applied.slice(expected.length).entries()) {
    const timestamp = Number(row.timestamp);
    if (
      !Number.isSafeInteger(timestamp) ||
      timestamp <= previous ||
      !/^[a-f0-9]{64}$/.test(row.hash)
    )
      throw new MigrationLedgerError(
        `PostgreSQL migration ledger has an invalid newer entry at position ${expected.length + index + 1}`,
      );
    previous = timestamp;
  }
}

/** Recovery requires an exact ledger. Older running code may accept a strictly newer suffix. */
export async function verifyMigrationLedger(
  db: Database,
  { allowNewer = false }: { allowNewer?: boolean } = {},
) {
  const expected = readMigrationFiles({ migrationsFolder });
  assertLedger(expected, await readAppliedLedger(db), allowNewer ? "required" : "exact");
  return getReleaseMigrationLedger(expected);
}

const COMMON_MIGRATION_COUNT = 41;
const LOCAL_CATEGORY_MIGRATION = 42;
const MERGED_CATALOG_PRESENTATION = originLedger[0]?.timestamp;
const CATEGORY_COLUMN = 'ALTER TABLE "service" ADD COLUMN "category" text;';

function legacyOriginEntries(
  expected: ReturnType<typeof readMigrationFiles>,
  applied: Awaited<ReturnType<typeof readAppliedLedger>>,
) {
  if (applied[COMMON_MIGRATION_COUNT]?.timestamp !== String(originLedger[0]?.legacyTimestamp))
    return [];
  assertLedger(
    expected.slice(0, COMMON_MIGRATION_COUNT),
    applied.slice(0, COMMON_MIGRATION_COUNT),
    "exact",
  );
  const suffix = applied.slice(COMMON_MIGRATION_COUNT);
  return suffix.map((row, index) => {
    const entry = originLedger[index];
    if (!entry || row.timestamp !== String(entry.legacyTimestamp) || row.hash !== entry.legacyHash)
      throw new MigrationLedgerError(
        "PostgreSQL migration ledger differs from the verified upstream prefix",
      );
    const migration = expected.find((candidate) => candidate.folderMillis === entry.timestamp);
    if (!migration) throw new MigrationLedgerError("Missing merged PostgreSQL migration");
    return { ...entry, migration };
  });
}

/** Applies pending drizzle-kit migrations in journal order. Only isolated rehearsal and test callers opt in to review databases. */
export async function runMigrations(
  db: Database,
  {
    online = false,
    allowReviewDatabase = false,
  }: { online?: boolean; allowReviewDatabase?: boolean } = {},
): Promise<void> {
  // Drizzle reads the journal before it opens the migration transaction.
  // Keep that read and the transaction on the session holding the advisory lock.
  const connection = await db.$client.reserve();
  try {
    await connection`select pg_advisory_lock(hashtextextended('sob-schema-migrations-v1', 0))`;
    const migrationDb = drizzle({ client: connection });
    if (!allowReviewDatabase) await assertOperationalDatabase(migrationDb);
    if (online) {
      const [schema] = await connection<{ live_views: boolean }[]>`
        select to_regprocedure('public.sync_record_live_view()') is not null as live_views
      `;
      if (!schema?.live_views) {
        throw new Error("Migration 0061 requires a maintenance upgrade with old writers drained.");
      }
    }
    const expected = readMigrationFiles({ migrationsFolder });
    const [journal] = await connection<{ initialized: boolean }[]>`
      select to_regclass('drizzle.__drizzle_migrations') is not null as initialized
    `;
    const applied = journal?.initialized ? await readAppliedLedger(migrationDb) : [];
    const legacy = legacyOriginEntries(expected, applied);
    if (legacy.length) {
      if (online)
        throw new Error("Merging the upstream migration history requires a maintenance upgrade.");
      const alreadyApplied = new Set(legacy.map(({ timestamp }) => timestamp));
      await migrationDb.transaction(async (tx) => {
        for (const migration of expected.slice(COMMON_MIGRATION_COUNT)) {
          const hasUpstreamEntry = alreadyApplied.has(migration.folderMillis);
          // Reconcile the upstream constraint with the wider limit already supported locally.
          if (hasUpstreamEntry && migration.folderMillis !== MERGED_CATALOG_PRESENTATION) continue;
          for (const statement of migration.sql) {
            // The verified first upstream migration already created this shared column.
            if (
              migration === expected[LOCAL_CATEGORY_MIGRATION] &&
              statement.trim() === CATEGORY_COLUMN
            ) {
              continue;
            }
            await tx.execute(sql.raw(statement));
          }
          if (!hasUpstreamEntry) {
            await tx.execute(sql`
              insert into drizzle.__drizzle_migrations(hash, created_at)
              values (${migration.hash}, ${migration.folderMillis})
            `);
          }
        }
        for (const entry of legacy) {
          await tx.execute(sql`
            update drizzle.__drizzle_migrations set hash = ${entry.migration.hash}, created_at = ${entry.timestamp}
            where hash = ${entry.legacyHash} and created_at = ${entry.legacyTimestamp}
          `);
        }
        assertLedger(expected, await readAppliedLedger(tx), "exact");
      });
      return;
    }
    assertLedger(expected, applied, "before-migration");
    if (
      online &&
      expected
        .slice(applied.length)
        .some(({ folderMillis }) => folderMillis === calendarBadgeBackfillTimestamp)
    ) {
      throw new Error(
        "Migration 0076 requires a maintenance upgrade with old API replicas drained.",
      );
    }
    if (
      online &&
      expected
        .slice(applied.length)
        .some(({ folderMillis }) => folderMillis === inventoryClassificationBackfillTimestamp)
    ) {
      throw new Error(
        "Migration 0099 requires a maintenance upgrade with old inventory writers drained.",
      );
    }
    if (
      online &&
      expected
        .slice(applied.length)
        .some(({ folderMillis }) => folderMillis === booksyPaymentReviewBackfillTimestamp)
    ) {
      throw new Error(
        "Migration 0101 requires a maintenance upgrade with old API replicas drained.",
      );
    }
    await migrate(migrationDb, { migrationsFolder });
    assertLedger(expected, await readAppliedLedger(migrationDb), "required");
  } finally {
    // Closing the session releases the advisory lock even when migration SQL aborted.
    await connection.close();
  }
}
