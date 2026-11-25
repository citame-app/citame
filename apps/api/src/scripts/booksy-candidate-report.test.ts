import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./booksy-candidate-report.ts", import.meta.url));
const privateFailure = "private reconciliation details must never reach the console";
const genericMessage =
  "Booksy reconciliation failed. Check the isolated copy, snapshot, date and any private option argument.";

test("candidate report distinguishes connection and migration failures without leaking details", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-test-report-"));
  const preload = join(directory, "preload.ts");
  try {
    const dbModule = JSON.stringify(import.meta.resolve("@sob/db"));
    await Bun.write(
      preload,
      `import { mock } from "bun:test";
const db = await import(${dbModule});
const failure = ${JSON.stringify(privateFailure)};
mock.module(${dbModule}, () => ({
  ...db,
  connectToNamedDatabase: async (_, options) => {
    if (!options?.readOnly || process.env.TEST_FAILURE === "read_only")
      throw new db.ReadOnlyConnectionError();
    return { db: {}, close: async () => {} };
  },
  verifyMigrationLedger: async (_, { allowNewer }) => {
    if (!allowNewer || process.env.TEST_FAILURE === "migration")
      throw new db.MigrationLedgerError(failure);
  },
}));
mock.module(${JSON.stringify(new URL("./booksy-backup.ts", import.meta.url).href)}, () => ({
  checkContainer: async () => {},
}));
mock.module(${JSON.stringify(new URL("../modules/booksy-transfer/operational-rehearsal.ts", import.meta.url).href)}, () => ({
  inspectNativeBooksy: async () => { throw new Error(failure); },
}));`,
    );
    for (const [failure, diagnostic] of [
      [
        "read_only",
        "Consultation requires a PostgreSQL connection in read-only mode. Check the isolated copy's connection settings.",
      ],
      [
        "migration",
        "The isolated copy has a different migration ledger. Check its history against the candidate release before restoring or upgrading a separate copy.",
      ],
      ["other", genericMessage],
    ] as const) {
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          "--no-env-file",
          "--preload",
          preload,
          script,
          "a".repeat(64),
          "2026-11-25",
        ],
        env: {
          ...process.env,
          BOOKSY_REHEARSAL_DATABASE_URL:
            "postgres://citame_import@127.0.0.1:5432/sob_booksy_candidate_20261125_1",
          TEST_FAILURE: failure,
        },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout.toString()).toBe("");
      expect(result.stderr.toString()).toBe(`${diagnostic}\n`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
