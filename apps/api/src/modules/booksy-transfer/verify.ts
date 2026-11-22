import { createHash } from "node:crypto";
import type { BooksyTransfer } from "@sob/contracts";
import {
  appointment,
  appointmentContext,
  appointmentService,
  clientProfile,
  type Database,
  service,
  serviceAddon,
  serviceStaff,
  staffProfile,
  timeOff,
  workingHours,
} from "@sob/db";
import { getTableColumns, inArray, sql } from "drizzle-orm";
import { unpackBooksyJson } from "./jsonb-codec";
import {
  booksyAddonLinks,
  fingerprint,
  matchesBooksyTarget,
  planBooksyTransfer,
  sourceUuid,
} from "./plan";
import type { BooksyArchiveManifest } from "./stage";
import { verifyArtifacts } from "./vault";

// A verified backup can precede the additive price-review migration.
export const archivedServiceColumns = {
  ...getTableColumns(appointmentService),
  priceType: sql<string>`coalesce(to_jsonb(${appointmentService})->>'price_type','fixed')`,
  peakSurchargeCents: sql<
    number | null
  >`(to_jsonb(${appointmentService})->>'peak_surcharge_cents')::integer`,
  reviewedPriceCents: sql<
    number | null
  >`(to_jsonb(${appointmentService})->>'reviewed_price_cents')::integer`,
};

const archivedCatalogColumns = {
  ...getTableColumns(service),
  sortOrder: sql<number>`coalesce((to_jsonb(${service})->>'sort_order')::integer,0)`,
  onlineBooking: sql<boolean>`coalesce((to_jsonb(${service})->>'online_booking')::boolean,true)`,
  clientInstructions: sql<string | null>`to_jsonb(${service})->>'client_instructions'`,
  bookingIntervalMinutes: sql<
    number | null
  >`(to_jsonb(${service})->>'booking_interval_minutes')::integer`,
  priceType: sql<string>`coalesce(to_jsonb(${service})->>'price_type','fixed')`,
};

const archivedStaffColumns = {
  ...getTableColumns(staffProfile),
  portraitAbsenceVersion: sql<
    string | null
  >`to_jsonb(${staffProfile})->>'portrait_absence_version'`,
};

export async function verifyBooksyAddonLinks(db: Pick<Database, "select">, input: BooksyTransfer) {
  const expected = new Set(
    booksyAddonLinks(input).map(({ addonId, serviceId }) => `${addonId}:${serviceId}`),
  );
  const saved = await db.select().from(serviceAddon);
  if (
    saved.length !== expected.size ||
    saved.some(({ addonId, serviceId }) => !expected.has(`${addonId}:${serviceId}`))
  )
    throw new Error("Native add-on eligibility differs from the source");
  return saved.length;
}

/** Read-only reconciliation, including exact archived bytes and every mapped native field. */
export async function verifyBooksyRehearsal(
  db: Database,
  root: string,
  manifest: BooksyArchiveManifest,
  expectedDocument: unknown,
) {
  const plan = planBooksyTransfer(expectedDocument);
  if (!plan.review.canRehearse || plan.input.businessId !== manifest.businessId)
    throw new Error("Expected bundle is invalid or belongs to another business");
  if (
    fingerprint(plan.input.artifacts) !==
    fingerprint(manifest.artifacts.map(({ kind: _kind, ...a }) => a))
  )
    throw new Error("Expected bundle and manifest contain different artifacts");
  await verifyArtifacts(root, { artifacts: manifest.artifacts });
  const identity = await db.execute<{ name: string }>(sql`select current_database() as name`);
  if (
    !/^sob_(?:test_booksy_transfer\w*|booksy_(?:rehearsal_\d{8}(?:_run[1-9]\d*)?|restorecheck_\d{8}_\d+))$/.test(
      identity[0]?.name ?? "",
    )
  )
    throw new Error("Verification requires an isolated rehearsal or restore database");
  const runs = await db.execute<{ document: unknown; review: unknown }>(
    sql`select document,review from booksy_rehearsal.run where business_id=${manifest.businessId} and document_hash=${plan.review.reviewHash}`,
  );
  if (
    runs.length !== 1 ||
    fingerprint(unpackBooksyJson(runs[0]!.document)) !== plan.review.reviewHash ||
    fingerprint(runs[0]!.review) !== fingerprint(plan.review)
  )
    throw new Error("The retained import document or review is missing or changed");
  const raw = await db.execute<{
    sha256: string;
    payload: Uint8Array;
    type: string;
    document: unknown;
  }>(
    sql`select sha256,payload,document,jsonb_typeof(document) as type from booksy_rehearsal.raw_capture where business_id=${manifest.businessId}`,
  );
  const indexed = new Map(raw.map((r) => [r.sha256, r]));
  let bytes = 0;
  for (const artifact of manifest.artifacts) {
    const row = indexed.get(artifact.sha256);
    if (!row) throw new Error("An archived source artifact is missing");
    const actual = Buffer.from(row.payload);
    if (
      actual.length !== artifact.bytes ||
      createHash("sha256").update(actual).digest("hex") !== artifact.sha256 ||
      row.type !== "object" ||
      fingerprint(unpackBooksyJson(row.document)) !==
        fingerprint(JSON.parse(actual.toString("utf8")))
    )
      throw new Error("An archived source artifact differs from its manifest");
    bytes += actual.length;
  }
  const counts = await verifyBooksyProjection(db, plan.input);
  return {
    database: identity[0]!.name,
    artifacts: manifest.artifacts.length,
    bytes,
    native: counts,
    sourceBytesVerified: true,
    nativeFieldsVerified: true,
    complete: false,
    canCutOver: false,
  };
}

/** Verifies data inherited from the rehearsal. Native candidate bookings have their own projection. */
export async function verifyBooksyProjection(
  db: Pick<Database, "select" | "execute">,
  input: BooksyTransfer,
  { candidate = false } = {},
) {
  const mappings = await db.execute<{
    kind: string;
    target_id: string;
    target_hash: string;
    source_hash: string;
  }>(
    sql`select kind,target_id,target_hash,source_hash from booksy_rehearsal.entity where business_id=${input.businessId}`,
  );
  const tables = {
    staff: staffProfile,
    services: service,
    clients: clientProfile,
    hours: workingHours,
    timeOff,
    assignments: serviceStaff,
    ...(candidate
      ? {}
      : {
          appointments: appointment,
          appointmentServices: appointmentService,
          contexts: appointmentContext,
        }),
  };
  const expectedSources = new Map<string, string>();
  const expectSource = (kind: string, id: string, row: unknown) =>
    expectedSources.set(`${kind}:${sourceUuid(input.businessId, kind, id)}`, fingerprint(row));
  for (const [kind, rows] of Object.entries({
    staff: input.staff,
    services: input.services,
    clients: input.clients,
    ...(candidate ? {} : { appointments: input.appointments }),
    hours: input.hours,
    timeOff: input.timeOff,
  }))
    for (const row of rows) expectSource(kind, row.sourceId, row);
  for (const row of input.assignments)
    expectSource("assignments", JSON.stringify([row.staffRef, row.serviceRef]), row);
  for (const visit of candidate ? [] : input.appointments)
    for (const segment of visit.services) {
      expectSource("appointmentServices", segment.sourceId, segment);
      expectSource("contexts", segment.sourceId, {
        segment,
        parentInternalNote: visit.internalNote,
      });
    }
  const reviewed = candidate ? mappings.filter((row) => Object.hasOwn(tables, row.kind)) : mappings;
  if (
    reviewed.length !== expectedSources.size ||
    reviewed.some((row) => expectedSources.get(`${row.kind}:${row.target_id}`) !== row.source_hash)
  )
    throw new Error(
      "Native mapping identifiers differ from the expected import document or source hashes",
    );
  const sourceCategories = new Map(
    input.services.map((item) => [
      sourceUuid(input.businessId, "services", item.sourceId),
      item.category,
    ]),
  );
  const counts: Record<string, number> = {};
  for (const [kind, table] of Object.entries(tables)) {
    const own = reviewed.filter((row) => row.kind === kind);
    counts[kind] = own.length;
    if (candidate) {
      const [total] = await db.select({ count: sql<number>`count(*)::int` }).from(table);
      if (total?.count !== own.length)
        throw new Error(`Native candidate row count differs: ${kind}`);
    }
    if (!own.length) continue;
    const ids = own.map((row) => row.target_id);
    const rows =
      table === appointmentService
        ? await db
            .select(archivedServiceColumns)
            .from(appointmentService)
            .where(inArray(appointmentService.id, ids))
        : table === staffProfile
          ? await db
              .select(archivedStaffColumns)
              .from(staffProfile)
              .where(inArray(staffProfile.id, ids))
          : table === service
            ? await db.select(archivedCatalogColumns).from(service).where(inArray(service.id, ids))
            : await db.select().from(table).where(inArray(table.id, ids));
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const expected of own) {
      const row = found.get(expected.target_id);
      if (
        !row ||
        !matchesBooksyTarget(
          kind,
          row,
          expected.target_hash,
          sourceCategories.get(expected.target_id),
        )
      )
        throw new Error(`Native projection changed: ${kind}`);
    }
  }
  counts.addonLinks = await verifyBooksyAddonLinks(db, input);
  return counts;
}
