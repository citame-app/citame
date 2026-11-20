import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import { unpackBooksyJson } from "./jsonb-codec";
import { type BooksyArchiveManifest, stageBooksyArchive } from "./stage";
import { archiveDocument } from "./vault";

let t: TestDatabase;
let root: string;
beforeAll(async () => {
  t = await createTestDatabase("booksy_transfer_vault");
  await t.db.execute(
    sql`do $$ begin if to_regclass('booksy_rehearsal.raw_capture') is not null then truncate booksy_rehearsal.raw_capture,booksy_rehearsal.raw_manifest; end if; end $$`,
  );
  root = await mkdtemp(join(tmpdir(), "citame-booksy-vault-"));
});
afterAll(async () => {
  await t.close();
  await rm(root, { recursive: true, force: true });
});
const manifest = (artifacts: BooksyArchiveManifest["artifacts"]): BooksyArchiveManifest => ({
  version: 1,
  businessId: "synthetic",
  fromDate: "2026-11-18",
  timezone: "Europe/Madrid",
  complete: false,
  artifacts,
  limitations: ["Synthetic fixture, incomplete"],
});
test("retains exact source bytes and unknown private fields idempotently, without creating native appointments", async () => {
  const document = {
    businessId: "synthetic",
    kind: "booksy-test",
    privateNote: "PRIVATE unknown field",
    unmapped: { value: 123 },
  };
  const artifact = await archiveDocument(root, document);
  const input = manifest([{ ...artifact, kind: document.kind }]);
  const first = await stageBooksyArchive(t.db, root, input);
  expect(first).toMatchObject({
    artifacts: 1,
    rawArchiveVerified: true,
    nativeAppointmentsImported: false,
    complete: false,
    cutover: false,
  });
  await stageBooksyArchive(t.db, root, input);
  const rows = await t.db.execute<{ payload: Uint8Array; document: unknown; type: string }>(
    sql`select payload,document,jsonb_typeof(document) as type from booksy_rehearsal.raw_capture`,
  );
  expect(rows).toHaveLength(1);
  expect(Buffer.from(rows[0]!.payload)).toEqual(await readFile(join(root, artifact.path)));
  expect(rows[0]?.document).toEqual(document);
  expect(rows[0]?.type).toBe("object");
  const native = await t.db.execute<{ count: number }>(
    sql`select count(*)::int as count from appointment`,
  );
  expect(native[0]?.count).toBe(0);
  await writeFile(join(root, artifact.path), "tampered");
  await expect(stageBooksyArchive(t.db, root, input)).rejects.toThrow("digest mismatch");
  const after = await t.db.execute<{ count: number }>(
    sql`select count(*)::int as count from booksy_rehearsal.raw_capture`,
  );
  expect(after[0]?.count).toBe(1);
});
test("relative path traversal and symlink escapes cannot import files outside the private archive", async () => {
  const outside = `${root}-outside.json`;
  const bytes = JSON.stringify({ businessId: "synthetic", kind: "booksy-test" });
  await writeFile(outside, bytes, { flag: "wx" });
  await symlink(outside, join(root, "escape.json"));
  const artifact = {
    path: "escape.json",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: Buffer.byteLength(bytes),
    kind: "booksy-test",
  };
  try {
    await expect(stageBooksyArchive(t.db, root, manifest([artifact]))).rejects.toThrow(
      "escapes archive root",
    );
  } finally {
    await rm(outside);
  }
});
test("PostgreSQL stores source NUL/surrogate metadata reversibly while original bytes stay exact", async () => {
  const original = { businessId: "synthetic", kind: "booksy-test", sort: ["a\u0000b", "\ud800"] };
  const artifact = await archiveDocument(root, original);
  const input = manifest([{ ...artifact, kind: original.kind }]);
  await stageBooksyArchive(t.db, root, input);
  await stageBooksyArchive(t.db, root, input);
  const rows = await t.db.execute<{ payload: Uint8Array; document: unknown }>(
    sql`select payload,document from booksy_rehearsal.raw_capture where sha256=${artifact.sha256}`,
  );
  expect(Buffer.from(rows[0]!.payload)).toEqual(await readFile(join(root, artifact.path)));
  expect(unpackBooksyJson(rows[0]!.document)).toEqual(original);
});
