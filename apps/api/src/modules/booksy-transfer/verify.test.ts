import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import { headSeq } from "../sync/pull";
import { transferFixture } from "./fixtures";
import { planBooksyTransfer } from "./plan";
import { applyBooksyRehearsal } from "./rehearsal";
import { rehearseRecoveredReplica } from "./replica-check";
import { type BooksyArchiveManifest, stageBooksyArchive } from "./stage";
import { archiveDocument, privateWriteVerified } from "./vault";
import { verifyBooksyProjection, verifyBooksyRehearsal } from "./verify";
import { planBooksyWaitlist } from "./waitlist";

let t: TestDatabase;
let root: string;
let input: ReturnType<typeof transferFixture>;
let manifest: BooksyArchiveManifest;

test("concurrent private receipts publish only one complete file without replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-private-receipt-"));
  try {
    const path = join(directory, "receipt.json");
    const variants = [JSON.stringify({ probe: "A".repeat(20000) }), JSON.stringify({ probe: "B" })];
    const results = await Promise.allSettled(
      variants.map((bytes) => privateWriteVerified(path, bytes)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const saved = await Bun.file(path).text();
    expect(variants).toContain(saved);
    await privateWriteVerified(path, saved);
    expect(await Bun.file(path).text()).toBe(saved);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readdir(directory)).toEqual(["receipt.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("private receipts use exact modes and replay with a restrictive process umask", async () => {
  const directory = await mkdtemp(join(tmpdir(), "citame-private-mode-"));
  try {
    const target = join(directory, "receipt.json");
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import { privateWriteVerified } from ${JSON.stringify(new URL("./vault.ts", import.meta.url).href)};
        process.umask(0o777);
        for (let index = 0; index < 2; index++) await privateWriteVerified(Bun.argv[1], "probe");`,
        target,
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    expect(await child.exited).toBe(0);
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(target).text()).toBe("probe");
    expect(await readdir(directory)).toEqual(["receipt.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  t = await createTestDatabase("booksy_transfer_verify");
  root = await mkdtemp(join(tmpdir(), "citame-booksy-verify-"));
  input = transferFixture();
  const artifact = await archiveDocument(root, {
    businessId: input.businessId,
    kind: "booksy-test",
    note: "PRIVATE",
  });
  input.artifacts = [artifact];
  manifest = {
    version: 1,
    businessId: input.businessId,
    fromDate: input.fromDate,
    timezone: input.timezone,
    complete: false,
    artifacts: [{ ...artifact, kind: "booksy-test" }],
    limitations: ["synthetic"],
  };
});
beforeEach(async () => {
  await t.reset();
  // reset() clears public tables. These tests also modify the separate rehearsal vault.
  await t.db.execute(sql`drop schema if exists booksy_rehearsal cascade`);
  await stageBooksyArchive(t.db, root, manifest);
  await applyBooksyRehearsal(t.db, input, planBooksyTransfer(input).review.reviewHash);
});
afterAll(async () => {
  await t.close();
  await rm(root, { recursive: true, force: true });
});
test("verifies archived bytes and native fields; detects a missing projection even when remaining hashes match", async () => {
  expect(await verifyBooksyRehearsal(t.db, root, manifest, input)).toMatchObject({
    sourceBytesVerified: true,
    nativeFieldsVerified: true,
    native: { appointments: 1, appointmentServices: 1, contexts: 1 },
    canCutOver: false,
  });
  await t.db.execute(sql`delete from booksy_rehearsal.entity where kind='contexts'`);
  await expect(verifyBooksyRehearsal(t.db, root, manifest, input)).rejects.toThrow(
    "mapping identifiers differ",
  );
});

test("staff projection verifies a pre-0075 schema and detects a non-null absence revision", async () => {
  const source = planBooksyTransfer(input).input;
  await expect(
    t.db.transaction(async (tx) => {
      await tx.execute(sql`alter table staff_profile drop column portrait_absence_version`);
      expect((await verifyBooksyProjection(tx, source)).staff).toBe(source.staff.length);
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
  await expect(
    t.db.transaction(async (tx) => {
      await tx.execute(sql`update staff_profile set portrait_absence_version = gen_random_uuid()`);
      await expect(verifyBooksyProjection(tx, source)).rejects.toThrow(
        "Native projection changed: staff",
      );
      tx.rollback();
    }),
  ).rejects.toThrow("Rollback");
  expect((await verifyBooksyProjection(t.db, source)).staff).toBe(source.staff.length);
});
test("detects changed frozen service fields and retained document independently", async () => {
  await t.db.execute(sql`update appointment_service set price_cents=1`);
  await expect(verifyBooksyRehearsal(t.db, root, manifest, input)).rejects.toThrow(
    "Native projection changed",
  );
  await t.db.execute(sql`update booksy_rehearsal.run set document='{}'::jsonb`);
  await expect(verifyBooksyRehearsal(t.db, root, manifest, input)).rejects.toThrow(
    "retained import document",
  );
});

test("checks restored visit groups and ordered frozen services in the desktop calendar feed", async () => {
  const originalHead = await headSeq(t.db);
  expect(originalHead).toBeGreaterThan(0);
  await t.db.execute(
    sql`update appointment set status='completed', visit_group_id=${Bun.randomUUIDv7()}::uuid`,
  );
  await t.db.execute(sql`insert into appointment_service
    (id, appointment_id, position, name, duration_minutes, buffer_minutes, price_cents, currency,
      source_unpriced, reviewed_price_cents, price_type)
    select ${Bun.randomUUIDv7()}::uuid, id, 1, 'Imported extra', 0, 0, 0, 'EUR', true, 725, 'hidden' from appointment`);
  expect(
    await rehearseRecoveredReplica(t.db, originalHead, { expectPaymentReannouncement: false }),
  ).toMatchObject({
    calendarLines: 1,
    reannouncedCalendarLines: 1,
    groupedCalendarLinesVerified: 1,
    frozenServicesVerified: 2,
  });
  await t.db.execute(sql`update appointment_service set position=0 where position=1`);
  await expect(
    rehearseRecoveredReplica(t.db, originalHead, { expectPaymentReannouncement: false }),
  ).rejects.toThrow("Recovered appointment has ambiguous frozen service order");
});
test("detects tampered parsed source metadata even if original archived bytes remain intact", async () => {
  await t.db.execute(sql`update booksy_rehearsal.raw_capture set document='{}'::jsonb`);
  await expect(verifyBooksyRehearsal(t.db, root, manifest, input)).rejects.toThrow(
    "source artifact differs",
  );
});

test("restores waitlist observations from original bytes even when the JSONB index has no route", async () => {
  const day = input.fromDate;
  const body = {
    results: [
      {
        id: 7,
        customer: { id: 42 },
        date: day,
        flexible: false,
        order: 1,
        slot_duration: "60 mins slot",
      },
    ],
  };
  const artifact = await archiveDocument(root, {
    businessId: input.businessId,
    kind: "booksy-api-response",
    capturedAt: input.capturedAt,
    source: `https://es.booksy.com/core/v2/business_api/me/businesses/${input.businessId}/waitlist/?start=${day}&end=${day}`,
    data: { body: JSON.stringify(body), data: body },
    retainedText: "Synthetic NUL \u0000",
  });
  await stageBooksyArchive(t.db, root, {
    ...manifest,
    artifacts: [...manifest.artifacts, { ...artifact, kind: "booksy-api-response" }],
  });
  const restore = () =>
    t.db.transaction(
      (tx) =>
        planBooksyWaitlist(tx, {
          businessId: input.businessId,
          fromDate: day,
          throughDate: day,
          base: {
            ...input,
            artifacts: [...input.artifacts, artifact],
            clients: [{ ...input.clients[0]!, sourceId: "42" }],
          },
        }),
      { accessMode: "read only" },
    );
  expect(await restore()).toMatchObject({
    observedDates: 1,
    entries: [{ requestedDate: day, durationMinutes: 60, sourceHash: artifact.sha256 }],
  });
  await t.db.execute(
    sql`update booksy_rehearsal.raw_capture set document='{}'::jsonb where sha256=${artifact.sha256}`,
  );
  expect((await restore()).entries).toHaveLength(1);
  await t.db.execute(
    sql`update booksy_rehearsal.raw_capture set payload=convert_to('{}','UTF8') where sha256=${artifact.sha256}`,
  );
  await expect(restore()).rejects.toThrow("archive is incomplete or has changed");
});

test("candidate verification checks the directory and schedule inherited from the reviewed snapshot", async () => {
  const check = () =>
    t.db.transaction((tx) => verifyBooksyProjection(tx, input, { candidate: true }), {
      accessMode: "read only",
    });
  expect(await check()).toMatchObject({
    clients: input.clients.length,
    staff: input.staff.length,
    services: input.services.length,
    hours: input.hours.length,
    assignments: input.assignments.length,
  });
  await t.db.execute(sql`update client_profile set name='Changed contact'`);
  await expect(check()).rejects.toThrow("Native projection changed: clients");
});
