import { createHash } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { connectToNamedDatabase, NO_DB_TIMEOUTS } from "@sob/db";
import { sql } from "drizzle-orm";
import { fingerprint } from "../modules/booksy-transfer/plan";
import type { BooksySourceReadModel } from "../modules/booksy-transfer/source-read-model";
import {
  loadBooksySourceModel,
  verifyBooksySourceModel,
} from "../modules/booksy-transfer/source-store";
import type { BooksyArchiveManifest } from "../modules/booksy-transfer/stage";
import { privateCliError, privateWrite } from "../modules/booksy-transfer/vault";
import { verifyBooksyRehearsal } from "../modules/booksy-transfer/verify";
import type { Tx } from "../tx";

async function runDocker(args: string[], stdin?: ReturnType<typeof Bun.file>) {
  const p = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "ignore",
    stdin: stdin ?? "ignore",
  });
  const [status, out] = await Promise.all([p.exited, new Response(p.stdout).text()]);
  if (status) throw new Error(`Local backup operation failed: ${args[2] ?? args[0]}`);
  return out;
}

export async function privateBooksyContainerPort(container: string) {
  const configuredHost = process.env.DOCKER_HOST;
  if (configuredHost && !configuredHost.startsWith("unix:///"))
    throw new Error("An isolated Booksy database requires a local Docker socket");
  const contextHost = (
    await runDocker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
  ).trim();
  if (!contextHost.startsWith("unix:///"))
    throw new Error("An isolated Booksy database requires a local Docker socket");
  const inspected = JSON.parse(await runDocker(["inspect", "--type", "container", container]))[0];
  const ports = inspected.NetworkSettings?.Ports?.["5432/tcp"];
  const port = ports?.[0]?.HostPort;
  if (
    inspected.Config?.Labels?.["citame.purpose"] !== "booksy-rehearsal" ||
    !inspected.State?.Running ||
    ports?.length !== 1 ||
    ports[0].HostIp !== "127.0.0.1" ||
    typeof port !== "string" ||
    !/^[1-9]\d{0,4}$/.test(port) ||
    Number(port) > 65535
  )
    throw new Error("Container ownership or private connection binding differs");
  return port;
}

export async function checkContainer(url: URL, container: string) {
  if ((await privateBooksyContainerPort(container)) !== url.port)
    throw new Error("Container ownership or private connection binding differs");
}

export async function dumpDatabase(
  container: string,
  database: string,
  dump: string,
  {
    snapshot,
    excludeReviewArchive = false,
  }: { snapshot?: string; excludeReviewArchive?: boolean } = {},
) {
  const handle = await open(dump, "wx", 0o600);
  try {
    const p = Bun.spawn(
      [
        "docker",
        "exec",
        container,
        "pg_dump",
        "-U",
        "citame_import",
        "-d",
        database,
        "--format=custom",
        "--no-owner",
        "--no-privileges",
        ...(snapshot ? [`--snapshot=${snapshot}`] : []),
        ...(excludeReviewArchive ? ["--exclude-schema=booksy_rehearsal"] : []),
      ],
      { stdout: handle.fd, stderr: "ignore" },
    );
    if (await p.exited)
      throw new Error("Backup failed; the partial dump was retained for inspection");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function restoreDatabase(container: string, database: string, dump: string) {
  await runDocker(["exec", container, "createdb", "-U", "citame_import", database]);
  await runDocker(
    [
      "exec",
      "-i",
      container,
      "pg_restore",
      "-U",
      "citame_import",
      "-d",
      database,
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
    ],
    Bun.file(dump),
  );
}

/** Back up an owned local rehearsal and restore into a NEW database; never clean/drop/replace. */
export async function backupBooksyRehearsal(
  manifestFile: string,
  bundleFile: string,
  date: string,
  sourceFile?: string,
) {
  if (!/^\d{8}$/.test(date)) throw new Error("Expected rehearsal date YYYYMMDD");
  const manifestPath = await realpath(manifestFile);
  const bundlePath = await realpath(bundleFile);
  const root = dirname(manifestPath);
  if (dirname(bundlePath) !== root)
    throw new Error("Bundle and manifest must share a private archive");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as BooksyArchiveManifest;
  const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
  const sourcePath = sourceFile ? await realpath(sourceFile) : undefined;
  if (sourcePath && dirname(sourcePath) !== root)
    throw new Error("Source snapshot must share the private archive");
  const source = sourcePath
    ? (JSON.parse(await readFile(sourcePath, "utf8")) as BooksySourceReadModel)
    : undefined;
  const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
  if (!connection) throw new Error("Use the private rehearsal connection file");
  const url = new URL(connection);
  const database = url.pathname.slice(1);
  const container = `citame-booksy-rehearsal-${date}`;
  if (
    url.hostname !== "127.0.0.1" ||
    url.username !== "citame_import" ||
    !new RegExp(`^sob_booksy_rehearsal_${date}(?:_run[1-9]\\d*)?$`).test(database)
  )
    throw new Error("Connection must target the owned local rehearsal");
  await checkContainer(url, container);
  const verify = async (name: string) => {
    const target = new URL(url);
    target.pathname = `/${name}`;
    const db = await connectToNamedDatabase(target.toString(), NO_DB_TIMEOUTS);
    try {
      const native = await verifyBooksyRehearsal(db.db, root, manifest, bundle);
      return {
        ...native,
        ...(source ? { sourceCopy: await verifyBooksySourceModel(db.db, source) } : {}),
      };
    } finally {
      await db.close();
    }
  };
  const before = await verify(database);
  const stamp = Date.now().toString();
  const dump = resolve(root, `postgres-${date}-${stamp}.dump`);
  await dumpDatabase(container, database, dump);
  const bytes = await readFile(dump);
  if (!bytes.length) throw new Error("Backup is empty");
  const restoredDatabase = `sob_booksy_restorecheck_${date}_${stamp}`;
  await restoreDatabase(container, restoredDatabase, dump);
  const after = await verify(restoredDatabase);
  const { database: _before, ...baseline } = before;
  const { database: _after, ...restored } = after;
  if (fingerprint(baseline) !== fingerprint(restored)) throw new Error("Restored database differs");
  const result = {
    dump,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    database,
    restoredDatabase,
    verifiedAt: new Date().toISOString(),
    verification: after,
    restorationVerified: true,
    complete: false,
    canCutOver: false,
  };
  const receipt = resolve(root, `restore-verification-${date}-${stamp}.json`);
  await privateWrite(receipt, JSON.stringify(result, null, 2));
  return { ...result, receipt };
}

/** Compares table rows as multisets of hashes. Physical row order can change during a restore. */
export async function fingerprintTables(tx: Tx) {
  await tx.execute(sql`set local time zone 'UTC'`);
  await tx.execute(sql`set local bytea_output = 'hex'`);
  const tables = await tx.execute<{ schema_name: string; table_name: string }>(sql`
    select schemaname as schema_name, tablename as table_name
    from pg_catalog.pg_tables
    where schemaname in ('public', 'drizzle', 'booksy_rehearsal')
    order by schemaname, tablename
  `);
  const content: { schema: string; table: string; rows: number; sha256: string }[] = [];
  for (const { schema_name, table_name } of tables) {
    const table = sql`${sql.identifier(schema_name)}.${sql.identifier(table_name)}`;
    const [digest] = await tx.execute<{ rows: number; sha256: string }>(sql`
      select count(*)::int as rows,
        encode(sha256(decode(coalesce(string_agg(row_hash, '' order by row_hash), ''), 'hex')), 'hex') as sha256
      from (
        select encode(sha256(convert_to(to_jsonb(data)::text, 'UTF8')), 'hex') as row_hash
        from ${table} as data
      ) as hashes
    `);
    if (!digest) throw new Error("Could not fingerprint a backup table");
    content.push({
      schema: schema_name,
      table: table_name,
      rows: digest.rows,
      sha256: digest.sha256,
    });
  }
  return content;
}

/** Restore the working projection, including its agenda, archive and pending waitlist. */
export async function backupBooksyCandidate(hash: string, outputDir: string) {
  const connection = process.env.BOOKSY_REHEARSAL_DATABASE_URL;
  if (!connection || !/^[a-f0-9]{64}$/.test(hash))
    throw new Error("Use the private candidate connection file and an immutable snapshot hash");
  const url = new URL(connection);
  const database = url.pathname.slice(1);
  const match = /^sob_booksy_candidate_(\d{8})_\d+$/.exec(database);
  if (
    !match ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "citame_import" ||
    url.search ||
    url.hash
  )
    throw new Error("Connection must target the owned local candidate");
  const container = `citame-booksy-rehearsal-${match[1]}`;
  await checkContainer(url, container);
  const root = await realpath(outputDir);
  const info = await stat(root);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.())
    throw new Error("Backup directory must be private and owned by the current account");

  const stamp = `${match[1]}_${Date.now()}`;
  const dump = resolve(root, `candidate-${stamp}.dump`);
  const restoredDatabase = `sob_booksy_restorecheck_${stamp}`;
  const source = await connectToNamedDatabase(url.href, NO_DB_TIMEOUTS);
  let before: Awaited<ReturnType<typeof fingerprintTables>>;
  try {
    before = await source.db.transaction(
      async (tx) => {
        const [row] = await tx.execute<{ snapshot: string }>(
          sql`select pg_export_snapshot() as snapshot`,
        );
        if (!row) throw new Error("Could not export candidate snapshot");
        const content = await fingerprintTables(tx);
        await dumpDatabase(container, database, dump, { snapshot: row.snapshot });
        return content;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } finally {
    await source.close();
  }
  const file = Bun.file(dump);
  if (!file.size) throw new Error("Backup is empty");
  const digest = createHash("sha256");
  for await (const chunk of file.stream()) digest.update(chunk);
  await restoreDatabase(container, restoredDatabase, dump);

  url.pathname = `/${restoredDatabase}`;
  const restored = await connectToNamedDatabase(url.href, NO_DB_TIMEOUTS);
  const verification = await (async () => {
    try {
      const after = await restored.db.transaction(fingerprintTables, {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      });
      if (fingerprint(before) !== fingerprint(after))
        throw new Error("Restored table contents differ");
      const model = await loadBooksySourceModel(restored.db, hash);
      const [calendar] = await restored.db.execute<{
        lines: number;
        groups: number;
        changed: number;
      }>(sql`
      select (select count(*)::int from appointment) as lines,
        (select count(distinct visit_group_id)::int from appointment) as groups,
        count(*) filter (where native.id is null or
          row(native.staff_id,native.client_id,native.starts_at,native.ends_at)
          is distinct from row(original.staff_id,original.client_id,original.starts_at,original.ends_at))::int as changed
      from booksy_rehearsal.source_appointment original
      left join appointment native on native.id = original.id
      where original.snapshot_hash = ${hash}
    `);
      if (
        calendar?.lines !== model.appointments.length ||
        calendar.groups !== model.groups.length ||
        calendar.changed !== 0
      )
        throw new Error("Restored calendar does not reconcile with the retained source");
      const [archive] = await restored.db.execute<{
        artifacts: number;
        bytes: number;
        changed: number;
      }>(sql`
      select count(*)::int as artifacts, sum(octet_length(payload))::int as bytes,
        count(*) filter (where sha256 <> encode(sha256(payload), 'hex'))::int as changed
      from booksy_rehearsal.raw_capture where business_id = ${model.businessId}
    `);
      if (!archive?.artifacts || archive.changed !== 0)
        throw new Error("Retained archive bytes differ");
      const count = (table: string) =>
        after.find((row) => row.schema === "public" && row.table === table)?.rows;
      return {
        tables: after.length,
        tableContentSha256: fingerprint(after),
        calendarLines: calendar.lines,
        visitGroups: calendar.groups,
        archivedArtifacts: archive.artifacts,
        archivedBytes: archive.bytes,
        frozenServices: count("appointment_service"),
        resourceAssignments: count("resource_reservation"),
        staffBlocks: count("time_off"),
        waitlistSourceRequests: count("waitlist_source_entry"),
        activeWaitlistEntries: count("waitlist_entry"),
        waitlistOffers: count("waitlist_offer"),
        checkouts: count("checkout"),
      };
    } finally {
      await restored.close();
    }
  })();
  const result = {
    dump,
    sha256: digest.digest("hex"),
    bytes: file.size,
    database,
    restoredDatabase,
    snapshotHash: hash,
    verifiedAt: new Date().toISOString(),
    verification,
    restorationVerified: true,
    canCutOver: false,
  };
  const receipt = resolve(root, `candidate-recovery-${stamp}.json`);
  await privateWrite(receipt, JSON.stringify(result, null, 2));
  return { ...result, receipt };
}

if (import.meta.main) {
  try {
    const [manifest, bundle, date, sourceFile] = process.argv.slice(2);
    if (!manifest || !bundle || !date || (manifest === "--candidate" && sourceFile))
      throw new Error(
        "Usage: booksy-backup.ts <manifest> <bundle> YYYYMMDD [source-snapshot], or --candidate <hash> <private-directory>",
      );
    console.log(
      JSON.stringify(
        manifest === "--candidate"
          ? await backupBooksyCandidate(bundle, date)
          : await backupBooksyRehearsal(manifest, bundle, date, sourceFile),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(privateCliError(error, "Backup verification failed"));
    process.exitCode = 1;
  }
}
