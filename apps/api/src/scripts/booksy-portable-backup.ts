import { createHash, randomBytes } from "node:crypto";
import { copyFile, link, lstat, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  assertNotBooksyReviewDatabase,
  assertOperationalDatabase,
  connectToNamedDatabase,
  getReleaseMigrationLedger,
  NO_DB_TIMEOUTS,
  runMigrations,
  verifyMigrationLedger,
} from "@sob/db";
import { RedisClient } from "bun";
import { z } from "zod";
import {
  OperationalAppProofError,
  rehearseNativeBooksyApp,
} from "../modules/booksy-transfer/operational-app-check";
import {
  assertBooksyCopySource,
  operationalProbePrefix,
  pauseBooksyCopyBooking,
} from "../modules/booksy-transfer/operational-copy-check";
import { inspectNativeBooksy } from "../modules/booksy-transfer/operational-rehearsal";
import { fingerprint } from "../modules/booksy-transfer/plan";
import { rehearseRecoveredReplica } from "../modules/booksy-transfer/replica-check";
import { OperationalMoveProofError } from "../modules/booksy-transfer/operational-move-check";
import { OperationalDesktopProofError } from "../modules/booksy-transfer/operational-desktop-check";
import { rehearseRestoredSchedule } from "../modules/booksy-transfer/schedule-check";
import { restoredStockEvidenceSchema } from "../modules/booksy-transfer/stock-check";
import { restoredWaitlistEvidenceSchema } from "../modules/booksy-transfer/waitlist-check";
import { privateWrite } from "../modules/booksy-transfer/vault";
import { headSeq } from "../modules/sync/pull";
import { dumpDatabase, fingerprintTables, restoreDatabase } from "./booksy-backup";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().positive();
const verifiedReceipt = z.object({
  dump: z.string(),
  sha256,
  bytes: size,
  database: z.string().regex(/^sob_booksy_candidate_\d{8}_\d+$/),
  snapshotHash: sha256,
  restorationVerified: z.literal(true),
  canCutOver: z.literal(false),
  verification: z.object({ tables: size, tableContentSha256: sha256 }),
});
const portableReceipt = z.strictObject({
  version: z.literal(1),
  sealedAt: z.iso.datetime(),
  snapshotHash: sha256,
  encryptedSha256: sha256,
  encryptedBytes: size,
  dumpSha256: sha256,
  dumpBytes: size,
  tableContentSha256: sha256,
  tables: size,
});
type PortableReceipt = z.infer<typeof portableReceipt>;
type PortableProbe = "none" | "schedule" | "operational-copy" | "operational-write";

const portableProbes = new Map<string, PortableProbe>([
  ["restore", "none"],
  ["rehearse-schedule", "schedule"],
  ["rehearse-operational-copy", "operational-copy"],
  ["rehearse-operational-write", "operational-write"],
]);

const rehearsalReference = z.object({
  snapshotHash: sha256,
  encryptedSha256: sha256,
  date: z.iso.date(),
});
const rehearsalReceipt = rehearsalReference.omit({ date: true }).extend({
  verifiedAt: z.iso.datetime(),
  tableContentSha256: sha256,
  tables: size,
  archiveArtifactsVerified: size,
  portableRestorationVerified: z.literal(true),
  day: z.object({ date: z.iso.date() }),
  candidate: z.object({
    calendarLines: size,
    products: z.number().int().nonnegative(),
    waitlistForReview: z.number().int().nonnegative(),
  }),
  canCutOver: z.literal(false),
  schedule: z.object({
    date: z.iso.date(),
    migrations: z.object({
      applied: size,
      headTimestamp: size,
      headSha256: sha256,
      ledgerSha256: sha256,
    }),
    migratedTables: size,
    migratedTableContentSha256: sha256,
    nativeProjectionVerifiedAfterMigration: z.literal(true),
    allTableContentsUnchanged: z.literal(true),
    rollbackVerified: z.literal(true),
    replica: z.object({ calendarLines: size }),
    professionalStartsRejected: size,
    equipmentStartsRejected: size,
    ordinaryStaffBooking: z.literal(true),
    ordinaryEquipmentBooking: z.literal(true),
    importedMovePreservedServiceAndContext: z.literal(true),
    staleMoveRejected: z.literal(true),
    ordinaryCheckoutMatchedFrozenPrice: z.literal(true),
    inventory: restoredStockEvidenceSchema,
    waitlist: restoredWaitlistEvidenceSchema,
  }),
});

class RehearsalEvidenceError extends Error {}

/** Check a trusted receipt against independently selected evidence and the local migration tree. */
export function verifyPortableBooksyRehearsal(
  receipt: unknown,
  reference: z.input<typeof rehearsalReference>,
) {
  const expected = rehearsalReference.safeParse(reference);
  const proof = rehearsalReceipt.safeParse(receipt);
  if (!expected.success)
    throw new RehearsalEvidenceError("Expected two SHA-256 hashes and an audit date");
  if (!proof.success)
    throw new RehearsalEvidenceError("Receipt does not record a successful migrated rehearsal");
  const { snapshotHash, encryptedSha256, date } = expected.data;
  const { day, schedule, verifiedAt } = proof.data;
  if (
    schedule.replica.calendarLines !== proof.data.candidate.calendarLines ||
    (schedule.inventory.status === "exercised") !== proof.data.candidate.products > 0 ||
    schedule.waitlist.sourceRequests !== proof.data.candidate.waitlistForReview ||
    schedule.waitlist.preparedOnce !== schedule.waitlist.sourceRequests ||
    schedule.waitlist.availableControls !== schedule.waitlist.sourceRequests ||
    schedule.waitlist.enabledPolicyRejections !== schedule.waitlist.sourceRequests ||
    schedule.waitlist.missingStaffPreferenceRejections !== schedule.waitlist.sourceRequests ||
    schedule.waitlist.anyProfessionalAccepted !== schedule.waitlist.sourceRequests ||
    schedule.waitlist.replaysWhileEnabled !== schedule.waitlist.sourceRequests
  )
    throw new RehearsalEvidenceError("Receipt does not record a successful migrated rehearsal");
  if (
    proof.data.snapshotHash !== snapshotHash ||
    proof.data.encryptedSha256 !== encryptedSha256 ||
    day.date !== date ||
    schedule.date !== date
  )
    throw new RehearsalEvidenceError(
      "Receipt does not match the selected snapshot, encrypted backup or rehearsal day",
    );

  const migrations = getReleaseMigrationLedger();
  if (fingerprint(schedule.migrations) !== fingerprint(migrations))
    throw new RehearsalEvidenceError("Receipt was verified against a different migration ledger");
  return {
    recoveryEvidenceVerified: true,
    verifiedAt,
    snapshotHash,
    encryptedSha256,
    date,
    migrations,
    inventory: schedule.inventory,
    waitlist: schedule.waitlist,
    canCutOver: false,
  };
}

async function privatePath(path: string, directory = false) {
  const metadata = await lstat(path);
  if (
    !(directory ? metadata.isDirectory() : metadata.isFile()) ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  )
    throw new Error("Expected a private path without symbolic links");
  return realpath(path);
}

async function checkFile(path: string, hash: string, bytes: number) {
  const actual = await digest(path);
  if (actual.sha256 !== hash || actual.bytes !== bytes)
    throw new Error("Backup length or SHA-256 differs from the trusted receipt");
}

async function digest(path: string) {
  const file = Bun.file(path);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of file.stream()) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

async function shell(
  label: string,
  args: string[],
  options: { stdout?: number; stdin?: ReturnType<typeof Bun.file> } = {},
) {
  const p = Bun.spawn(args, {
    stdout: options.stdout ?? "pipe",
    stderr: "ignore",
    stdin: options.stdin ?? "ignore",
  });
  const [code, output] = await Promise.all([
    p.exited,
    typeof p.stdout === "object" ? new Response(p.stdout).text() : Promise.resolve(""),
  ]);
  if (code !== 0) throw new Error(`${label} failed`);
  return output.trim();
}

async function writeFromCommand(
  path: string,
  label: string,
  args: string[],
  stdin?: ReturnType<typeof Bun.file>,
) {
  const handle = await open(path, "wx", 0o600);
  try {
    await shell(label, args, { stdout: handle.fd, stdin });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const gpg = (keyring: string) => [
  "gpg",
  "--no-options",
  "--homedir",
  keyring,
  "--batch",
  "--no-tty",
  "--no-auto-key-retrieve",
  "--no-auto-key-locate",
];

/** Seal only the verified dump. Connection, owner credentials and recovery keys stay separate. */
export async function sealBooksyBackup(
  receiptPath: string,
  outputPath: string,
  keyringPath: string,
  recipient: string,
) {
  if (!/^(?:[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64})$/.test(recipient))
    throw new Error("Pass the approved recipient's full OpenPGP fingerprint");
  const receipt = await privatePath(receiptPath);
  const source = verifiedReceipt.parse(JSON.parse(await readFile(receipt, "utf8")));
  const filename = basename(source.dump);
  if (!/^candidate-\d{8}_\d+\.dump$/.test(filename))
    throw new Error("Invalid candidate backup filename");
  const dump = await privatePath(join(dirname(receipt), filename));
  const output = await privatePath(outputPath, true);
  const keyring = await privatePath(keyringPath, true);
  const stage = await mkdtemp(join(tmpdir(), "citame-booksy-sealing-"));
  try {
    // Bind the exact input used by the encryption command even if the source path changes.
    const copy = join(stage, "candidate.dump");
    await copyFile(dump, copy);
    await checkFile(copy, source.sha256, source.bytes);
    const outputStage = await mkdtemp(join(output, ".sealing-"));
    try {
      const sealed = join(outputStage, "candidate.dump.gpg");
      await writeFromCommand(sealed, "OpenPGP encryption", [
        ...gpg(keyring),
        "--trust-model",
        "always",
        "--cipher-algo",
        "AES256",
        "--compress-algo",
        "none",
        "--recipient",
        recipient,
        "--output",
        "-",
        "--encrypt",
        copy,
      ]);
      const encrypted = await digest(sealed);
      if (!encrypted.bytes) throw new Error("Empty encrypted backup");
      const result: PortableReceipt = {
        version: 1,
        sealedAt: new Date().toISOString(),
        snapshotHash: source.snapshotHash,
        encryptedSha256: encrypted.sha256,
        encryptedBytes: encrypted.bytes,
        dumpSha256: source.sha256,
        dumpBytes: source.bytes,
        tableContentSha256: source.verification.tableContentSha256,
        tables: source.verification.tables,
      };
      const archive = join(output, `citame-review-${encrypted.sha256}.dump.gpg`);
      const manifest = `${archive}.json`;
      await link(sealed, archive);
      await privateWrite(manifest, JSON.stringify(result, null, 2));
      return { archive, manifest, ...result };
    } finally {
      await rm(outputStage, { recursive: true, force: true });
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

async function withRecoveryValkey<T>(suffix: string, run: (valkey: RedisClient) => Promise<T>) {
  const name = `citame-booksy-recovery-cache-${suffix}`;
  const password = randomBytes(32).toString("hex");
  await shell("Disposable Valkey startup", [
    "docker",
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    name,
    "--label",
    "citame.purpose=booksy-portable-recovery",
    "--publish",
    "127.0.0.1::6379",
    "--tmpfs",
    "/data",
    "valkey/valkey:9.1-alpine",
    "valkey-server",
    "--appendonly",
    "no",
    "--save",
    "",
    "--requirepass",
    password,
  ]);
  try {
    const binding = await shell("Valkey port inspection", ["docker", "port", name, "6379/tcp"]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error("Disposable Valkey must use a private loopback port");
    const valkey = new RedisClient(`redis://default:${password}@127.0.0.1:${port}`, {
      connectionTimeout: 1_000,
      maxRetries: 2,
    });
    try {
      await valkey.send("PING", []);
      return await run(valkey);
    } finally {
      valkey.close();
    }
  } finally {
    await shell("Disposable Valkey shutdown", ["docker", "stop", "--timeout", "5", name]);
  }
}

async function restoreInIsolatedPostgres(
  stage: string,
  dump: string,
  expected: PortableReceipt,
  date: string,
  probe: PortableProbe,
) {
  // A Docker context can point to another machine. Never send the decrypted dump there.
  const explicitEndpoint = process.env.DOCKER_HOST;
  if (explicitEndpoint && !explicitEndpoint.startsWith("unix:///"))
    throw new Error("Portable recovery requires a local Docker socket");
  const endpoint = await shell("Docker context inspection", [
    "docker",
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (!endpoint.startsWith("unix:///"))
    throw new Error("Portable recovery requires a local Docker socket");

  const suffix = randomBytes(8).toString("hex");
  const container = `citame-booksy-recovery-${suffix}`;
  const database = `sob_booksy_restorecheck_${date.replaceAll("-", "")}_${Date.now()}`;
  const password = randomBytes(32).toString("hex");
  const env = join(stage, "postgres.env");
  await privateWrite(
    env,
    `POSTGRES_USER=citame_import\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=postgres\n`,
  );
  await shell("Disposable PostgreSQL startup", [
    "docker",
    "run",
    "--detach",
    "--rm",
    "--pull=never",
    "--name",
    container,
    "--label",
    "citame.purpose=booksy-portable-recovery",
    "--publish",
    "127.0.0.1::5432",
    "--tmpfs",
    "/var/lib/postgresql",
    "--env-file",
    env,
    "postgres:18-alpine",
  ]);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await shell("PostgreSQL readiness", [
          "docker",
          "exec",
          container,
          "pg_isready",
          "-h",
          "127.0.0.1",
          "-U",
          "citame_import",
          "-d",
          "postgres",
        ]);
        ready = true;
        break;
      } catch {
        await Bun.sleep(1000);
      }
    }
    if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
    const binding = await shell("PostgreSQL port inspection", [
      "docker",
      "port",
      container,
      "5432/tcp",
    ]);
    const port = /^127\.0\.0\.1:(\d+)$/.exec(binding)?.[1];
    if (!port) throw new Error("Disposable PostgreSQL must use a private loopback port");
    await restoreDatabase(container, database, dump);
    const connection = await connectToNamedDatabase(
      `postgres://citame_import:${password}@127.0.0.1:${port}/${database}`,
      NO_DB_TIMEOUTS,
    );
    try {
      const readTables = () =>
        connection.db.transaction(fingerprintTables, {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        });
      const tables = await readTables();
      if (tables.length !== expected.tables || fingerprint(tables) !== expected.tableContentSha256)
        throw new Error("Restored tables differ from the source");
      const report = await inspectNativeBooksy(connection.db, expected.snapshotHash, date);
      const result = {
        verifiedAt: new Date().toISOString(),
        encryptedSha256: expected.encryptedSha256,
        snapshotHash: expected.snapshotHash,
        tableContentSha256: expected.tableContentSha256,
        tables: tables.length,
        portableRestorationVerified: true,
        day: report.day,
        candidate: report.candidate,
        archiveArtifactsVerified: report.source.archiveArtifactsVerified,
        canCutOver: false,
      };
      if (probe === "none") return result;

      // The archive fingerprint belongs to the original schema. Exercise the
      // current application on a migrated copy and use its own baseline.
      const originalHead = await headSeq(connection.db);
      await runMigrations(connection.db, { allowReviewDatabase: true });
      const migrations = await verifyMigrationLedger(connection.db);
      await inspectNativeBooksy(connection.db, expected.snapshotHash, date);
      const migrated = await readTables();
      const migratedTableContentSha256 = fingerprint(migrated);
      if (probe === "operational-copy" || probe === "operational-write") {
        await connection.db.transaction(assertBooksyCopySource, { accessMode: "read only" });
        const nativeDump = join(stage, "native-copy.dump");
        await dumpDatabase(container, database, nativeDump, { excludeReviewArchive: true });
        const nativeDatabase = `${operationalProbePrefix}${suffix}`;
        await restoreDatabase(container, nativeDatabase, nativeDump);
        const nativeUrl = `postgres://citame_import:${password}@127.0.0.1:${port}/${nativeDatabase}`;
        assertNotBooksyReviewDatabase(nativeUrl);
        const native = await connectToNamedDatabase(nativeUrl, NO_DB_TIMEOUTS);
        try {
          await assertOperationalDatabase(native.db);
          await verifyMigrationLedger(native.db);
          const sourceNative = migrated.filter(({ schema }) => schema !== "booksy_rehearsal");
          const copyBefore = await native.db.transaction(fingerprintTables, {
            accessMode: "read only",
          });
          if (fingerprint(copyBefore) !== fingerprint(sourceNative))
            throw new Error("Native copy differs from the reviewed application tables");
          await pauseBooksyCopyBooking(native.db);
          const stableTables = ({ table }: { table: string }) =>
            table !== "salon_settings" && table !== "sync_change";
          const copyAfter = await native.db.transaction(fingerprintTables, {
            accessMode: "read only",
          });
          if (
            fingerprint(copyAfter.filter(stableTables)) !==
            fingerprint(sourceNative.filter(stableTables))
          )
            throw new Error("Pausing public booking changed unrelated application tables");
          const replica = await rehearseRecoveredReplica(native.db, originalHead);
          const appFixtureTables = new Set([
            "user",
            "account",
            "session",
            "client_profile",
            "sync_change",
            "oauth_resource",
            "oauth_client",
            "oauth_client_resource",
            "jwks",
          ]);
          const preservedTables = ({ schema, table }: { schema: string; table: string }) =>
            schema !== "public" || !appFixtureTables.has(table);
          const readAppTables = () =>
            native.db.transaction(fingerprintTables, { accessMode: "read only" });
          const verifyAppBaseline = async () => {
            const copyProbed = await readAppTables();
            if (
              fingerprint(copyProbed.filter(preservedTables)) !==
              fingerprint(copyAfter.filter(preservedTables))
            )
              throw new Error("The read-only application proof changed application data");
            return copyProbed;
          };
          let beforeMove: Awaited<ReturnType<typeof readAppTables>> | undefined;
          const application = await withRecoveryValkey(suffix, (valkey) =>
            rehearseNativeBooksyApp(
              native.db,
              valkey,
              date,
              report.day.calendarLines,
              probe === "operational-write"
                ? {
                    move: {
                      verifyBeforeWrite: async () => {
                        beforeMove = await verifyAppBaseline();
                      },
                    },
                  }
                : undefined,
            ),
          );
          if (probe === "operational-copy") await verifyAppBaseline();
          else {
            const moveTables = new Set([
              "oauth_access_token",
              "oauth_consent",
              "desktop_device",
              "verification",
              "appointment",
              "staff_reservation",
              "resource_reservation",
              "audit_log",
              "reminder",
              "sync_change",
            ]);
            const unrelated = ({ schema, table }: { schema: string; table: string }) =>
              schema !== "public" || !moveTables.has(table);
            if (
              !beforeMove ||
              fingerprint((await readAppTables()).filter(unrelated)) !==
                fingerprint(beforeMove.filter(unrelated))
            )
              throw new Error("The native reschedule changed unrelated application tables");
          }
          if (
            replica.calendarLines !== report.candidate.calendarLines ||
            fingerprint(await readTables()) !== migratedTableContentSha256
          )
            throw new Error("Native copy verification differs from the reviewed source");
          return {
            ...result,
            operationalCopy: {
              nativeTablesVerified: copyAfter.length,
              nativeTableContentSha256: fingerprint(copyAfter),
              migrations,
              replica,
              application,
              privateArchiveExcluded: true,
              originalArchiveUnchanged: true,
              onlineBookingPaused: true,
              credentialAndDeliveryTablesEmptyBeforeRehearsal: true,
            },
          };
        } finally {
          await native.close();
        }
      }
      const replica = await rehearseRecoveredReplica(connection.db, originalHead);
      const proof = await rehearseRestoredSchedule(connection.db, date);
      if (fingerprint(await readTables()) !== migratedTableContentSha256)
        throw new Error("Scheduling rehearsal changed the migrated table contents");
      const rehearsal = {
        ...result,
        schedule: {
          ...proof,
          replica,
          migrations,
          migratedTables: migrated.length,
          migratedTableContentSha256,
          nativeProjectionVerifiedAfterMigration: true,
          allTableContentsUnchanged: true,
        },
      };
      rehearsalReceipt.parse(rehearsal);
      return rehearsal;
    } finally {
      await connection.close();
    }
  } finally {
    await shell("Disposable PostgreSQL shutdown", ["docker", "stop", "--timeout", "10", container]);
  }
}

/** Recover independently of the source server and retain only the aggregate evidence. */
export async function restorePortableBooksyBackup(
  archive: string,
  manifest: string,
  expectedCipherHash: string,
  keyringPath: string,
  date: string,
  options: { passphrasePath?: string; probe?: PortableProbe } = {},
) {
  const selectedDay = z.iso.date().parse(date);
  const trustedHash = sha256.parse(expectedCipherHash);
  if (!(await lstat(archive)).isFile() || !(await lstat(manifest)).isFile())
    throw new Error("The encrypted archive and its receipt must be regular files");
  const expected = portableReceipt.parse(JSON.parse(await readFile(manifest, "utf8")));
  if (expected.encryptedSha256 !== trustedHash)
    throw new Error("Receipt does not match the independently recorded encrypted SHA-256");
  const keyring = await privatePath(keyringPath, true);
  const passphrase = options.passphrasePath
    ? Bun.file(await privatePath(options.passphrasePath))
    : undefined;
  const stage = await mkdtemp(join(tmpdir(), "citame-booksy-recovery-"));
  try {
    const encrypted = join(stage, "candidate.dump.gpg");
    await copyFile(archive, encrypted);
    await checkFile(encrypted, trustedHash, expected.encryptedBytes);
    const dump = join(stage, "candidate.dump");
    await writeFromCommand(
      dump,
      "OpenPGP decryption",
      [
        ...gpg(keyring),
        ...(passphrase ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"] : []),
        "--output",
        "-",
        "--decrypt",
        encrypted,
      ],
      passphrase,
    );
    await checkFile(dump, expected.dumpSha256, expected.dumpBytes);
    return await restoreInIsolatedPostgres(
      stage,
      dump,
      expected,
      selectedDay,
      options.probe ?? "none",
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const [operation, ...args] = process.argv.slice(2);
    const probe = portableProbes.get(operation ?? "");
    if (operation === "seal" && args.length === 4) {
      const [receipt, output, keyring, recipient] = args as [string, string, string, string];
      console.log(
        JSON.stringify(await sealBooksyBackup(receipt, output, keyring, recipient), null, 2),
      );
    } else if (probe && args.length === 5) {
      const [archive, receipt, sha, keyring, date] = args as [
        string,
        string,
        string,
        string,
        string,
      ];
      console.log(
        JSON.stringify(
          await restorePortableBooksyBackup(
            resolve(archive),
            resolve(receipt),
            sha,
            keyring,
            date,
            {
              passphrasePath: process.env.BOOKSY_RECOVERY_PASSPHRASE_FILE,
              probe,
            },
          ),
          null,
          2,
        ),
      );
    } else if (operation === "verify-rehearsal" && args.length === 4) {
      const [receipt, snapshotHash, encryptedSha256, date] = args as [
        string,
        string,
        string,
        string,
      ];
      const path = await privatePath(receipt);
      const evidence = await Bun.file(path).json();
      console.log(
        JSON.stringify(
          verifyPortableBooksyRehearsal(evidence, { snapshotHash, encryptedSha256, date }),
          null,
          2,
        ),
      );
    } else {
      throw new Error(
        "Expected seal <verified-receipt> <private-output-dir> <keyring> <recipient-fingerprint>, restore / rehearse-schedule / rehearse-operational-copy / rehearse-operational-write <archive> <receipt> <trusted-sha256> <keyring> <date>, or verify-rehearsal <rehearsal-receipt> <snapshot-sha256> <trusted-cipher-sha256> <date>",
      );
    }
  } catch (error) {
    // Never print subprocess stderr, database rows, or arguments that may include private data.
    const allowed =
      error instanceof Error &&
      !("query" in error) &&
      [
        /^OpenPGP (encryption|decryption) failed$/,
        /^Backup length or SHA-256 differs from the trusted receipt$/,
        /^Receipt does not match the independently recorded encrypted SHA-256$/,
        /^Portable recovery requires a local Docker socket$/,
        /^Disposable Valkey startup failed$/,
        /^Unexpected schemas or database objects in the copy source$/,
        /^The copy source contains access credentials or delivery configuration$/,
        /^Expected seal </,
      ].some((pattern) => pattern.test(error.message));
    console.error(
      error instanceof RehearsalEvidenceError ||
        error instanceof OperationalAppProofError ||
        error instanceof OperationalMoveProofError ||
        error instanceof OperationalDesktopProofError ||
        (allowed && error instanceof Error)
        ? error.message
        : "Portable backup check failed. Verify the private files, recovery key and isolated PostgreSQL installation.",
    );
    process.exitCode = 1;
  }
}
