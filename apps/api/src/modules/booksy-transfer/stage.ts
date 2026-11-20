import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import { packBooksyJson } from "./jsonb-codec";

export interface BooksyArchiveManifest {
  version: 1;
  businessId: string;
  fromDate: string;
  timezone: "Europe/Madrid";
  complete: false;
  artifacts: { path: string; sha256: string; bytes: number; kind: string }[];
  limitations: string[];
}
/** Copy exact artifact bytes to an isolated vault; raw capture is never reported as native appointments. */
export async function stageBooksyArchive(
  db: Database,
  root: string,
  manifest: BooksyArchiveManifest,
) {
  const identity = await db.execute<{ name: string }>(sql`select current_database() as name`);
  if (
    !/^sob_(?:test_booksy_transfer\w*|booksy_rehearsal_\d{8}(?:_run[1-9]\d*)?)$/.test(
      identity[0]?.name ?? "",
    )
  )
    throw new Error("Raw staging requires an isolated rehearsal database");
  if (
    manifest.version !== 1 ||
    manifest.complete !== false ||
    manifest.timezone !== "Europe/Madrid" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(manifest.fromDate)
  )
    throw new Error("Invalid rehearsal archive manifest");
  if (!manifest.artifacts.length) throw new Error("Archive has no artifacts");
  const base = await realpath(root);
  const documents: {
    artifact: BooksyArchiveManifest["artifacts"][number];
    bytes: Buffer;
    document: Record<string, unknown>;
  }[] = [];
  const ids = new Set<string>();
  for (const artifact of manifest.artifacts) {
    if (ids.has(artifact.sha256)) throw new Error("Duplicate artifact digest");
    ids.add(artifact.sha256);
    if (isAbsolute(artifact.path)) throw new Error("Archive paths must be relative");
    const path = await realpath(resolve(base, artifact.path));
    const local = relative(base, path);
    if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
      throw new Error("Artifact escapes archive root");
    const info = await stat(path);
    if (!info.isFile() || info.size > 100_000_000) throw new Error("Invalid artifact file");
    const bytes = await readFile(path);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== artifact.sha256 || bytes.length !== artifact.bytes)
      throw new Error(`Archive digest mismatch: ${artifact.path}`);
    const document = JSON.parse(bytes.toString("utf8"));
    let sameBusiness = document.businessId === manifest.businessId;
    if (document.businessId === undefined && typeof document.url === "string") {
      const source = new URL(document.url);
      sameBusiness =
        source.protocol === "https:" &&
        source.hostname === "booksy.com" &&
        source.pathname.startsWith(`/pro/es-es/${manifest.businessId}/`);
    }
    if (!sameBusiness) throw new Error("Artifact belongs to another business");
    documents.push({ artifact, bytes, document });
  }
  await db.execute(sql`create schema if not exists booksy_rehearsal`);
  await db.execute(
    sql`create table if not exists booksy_rehearsal.raw_capture (business_id text not null,sha256 text not null,kind text not null,path text not null,payload bytea not null,document jsonb not null,created_at timestamptz not null default now(),primary key(business_id,sha256))`,
  );
  await db.execute(
    sql`create table if not exists booksy_rehearsal.raw_manifest (sha256 text primary key,business_id text not null,manifest jsonb not null,created_at timestamptz not null default now())`,
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('booksy-rehearsal-import-v1',0))`,
    );
    for (const { artifact, bytes, document } of documents) {
      const existing = await tx.execute<{ payload: Uint8Array }>(
        sql`select payload from booksy_rehearsal.raw_capture where business_id=${manifest.businessId} and sha256=${artifact.sha256}`,
      );
      if (existing[0]) {
        if (!Buffer.from(existing[0].payload).equals(bytes))
          throw new Error("Existing archive bytes differ");
        continue;
      }
      await tx.execute(
        sql`insert into booksy_rehearsal.raw_capture(business_id,sha256,kind,path,payload,document) values(${manifest.businessId},${artifact.sha256},${artifact.kind},${artifact.path},${bytes},${packBooksyJson(document)}::jsonb)`,
      );
    }
    const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    await tx.execute(
      sql`insert into booksy_rehearsal.raw_manifest(sha256,business_id,manifest) values(${hash},${manifest.businessId},${manifest}::jsonb) on conflict do nothing`,
    );
    const verified = await tx.execute<{ count: number }>(
      sql`select count(*)::int as count from booksy_rehearsal.raw_capture where business_id=${manifest.businessId} and sha256 in (${sql.join(
        [...ids].map((id) => sql`${id}`),
        sql`, `,
      )})`,
    );
    if (verified[0]?.count !== documents.length) throw new Error("Staged artifact count mismatch");
    return {
      database: identity[0]!.name,
      businessId: manifest.businessId,
      artifacts: documents.length,
      bytes: documents.reduce((s, d) => s + d.bytes.length, 0),
      sha256: hash,
      rawArchiveVerified: true,
      nativeAppointmentsImported: false,
      complete: false,
      cutover: false,
    };
  });
}
