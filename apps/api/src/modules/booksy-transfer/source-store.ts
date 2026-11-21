import { packageContentSchema } from "@sob/contracts";
import {
  booksyDesktopTestDatabase,
  type Database,
  resourcePool,
  retailProduct,
  stockMovement,
  stockReservation,
} from "@sob/db";
import { eq, getTableColumns, sql } from "drizzle-orm";
import { z } from "zod";
import { packBooksyJson, unpackBooksyJson } from "./jsonb-codec";
import { fingerprint, sourceUuid } from "./plan";
import { type BooksySourceReadModel, booksyCents } from "./source-read-model";

type ReadSourceDb = Pick<Database, "execute" | "select">;
type SourceVerification = { exclusiveExtensions?: boolean };

const { stockAllocated: _, ...sourceProductColumns } = getTableColumns(retailProduct);
const {
  packageContentQuantity: __,
  packageContentUnit: ___,
  ...legacyProductColumns
} = sourceProductColumns;
// Keep these fields fixed so new bookkeeping columns cannot change an archived opening hash.
const sourceStockColumns = {
  id: stockMovement.id,
  productId: stockMovement.productId,
  quantityDelta: stockMovement.quantityDelta,
  kind: stockMovement.kind,
  reason: stockMovement.reason,
  unitCostCents: stockMovement.unitCostCents,
  checkoutLineId: stockMovement.checkoutLineId,
  createdBy: stockMovement.createdBy,
  idempotencyKey: stockMovement.idempotencyKey,
  requestHash: stockMovement.requestHash,
  createdAt: stockMovement.createdAt,
};

function matchesExtensionFingerprint(row: Record<string, unknown>, expected: string) {
  if (fingerprint(row) === expected) return true;
  // Older receipts predate these columns; only their unchanged NULL default can be omitted.
  const { packageContentQuantity, packageContentUnit, ...original } = row;
  return (
    packageContentQuantity === null &&
    packageContentUnit === null &&
    fingerprint(original) === expected
  );
}

async function isolated(db: ReadSourceDb, readCandidate = false) {
  const rows = await db.execute<{ name: string }>(sql`select current_database() as name`);
  const name = rows[0]?.name ?? "";
  const desktopTest = booksyDesktopTestDatabase.test(name);
  if (
    !(readCandidate && (desktopTest || /^sob_booksy_candidate_\d{8}_\d+$/.test(name))) &&
    !/^sob_(?:test_booksy_transfer\w*|booksy_(?:rehearsal_\d{8}(?:_run[1-9]\d*)?|restorecheck_\d{8}_\d+))$/.test(
      name,
    )
  )
    throw new Error("Consultation copies require an isolated import database");
  return { desktopTest };
}
export async function storeBooksySourceModel(db: Database, model: BooksySourceReadModel) {
  await isolated(db);
  await db.execute(sql`create schema if not exists booksy_rehearsal`);
  await db.execute(
    sql`create table if not exists booksy_rehearsal.source_snapshot(hash text primary key,business_id text not null,document jsonb not null,created_at timestamptz not null default now())`,
  );
  await db.execute(
    sql`create table if not exists booksy_rehearsal.source_appointment(snapshot_hash text not null references booksy_rehearsal.source_snapshot(hash),id uuid not null,staff_id uuid not null,client_id uuid not null,starts_at timestamptz not null,ends_at timestamptz not null,payload jsonb not null,context jsonb not null,primary key(snapshot_hash,id))`,
  );
  await db.execute(
    sql`create index if not exists booksy_source_window_idx on booksy_rehearsal.source_appointment(staff_id,starts_at,ends_at)`,
  );
  const hash = fingerprint(model);
  await db.execute(
    sql`create table if not exists booksy_rehearsal.source_entity(snapshot_hash text not null references booksy_rehearsal.source_snapshot(hash),kind text not null,source_id text not null,target_id uuid not null,target_hash text not null,raw jsonb not null,primary key(snapshot_hash,kind,source_id))`,
  );
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('booksy-rehearsal-import-v1',0))`,
    );
    const old = await tx.execute<{ document: unknown }>(
      sql`select document from booksy_rehearsal.source_snapshot where hash=${hash}`,
    );
    if (old.length) {
      if (fingerprint(unpackBooksyJson(old[0]!.document)) !== hash)
        throw new Error("Retained source snapshot changed");
      return;
    }
    if (
      new Set(model.appointments.map((a) => a.id)).size !== model.appointments.length ||
      model.summary.bookedServices !== model.appointments.length ||
      model.groups.reduce((n, g) => n + g.ids.length, 0) !== model.appointments.length
    )
      throw new Error("Source copy identifiers/counts do not reconcile");
    await tx.execute(
      sql`insert into booksy_rehearsal.source_snapshot(hash,business_id,document) values(${hash},${model.businessId},${packBooksyJson(model)}::jsonb)`,
    );
    for (const a of model.appointments) {
      const context = model.contexts[a.id];
      if (!context) throw new Error("Source annotations are missing");
      await tx.execute(
        sql`insert into booksy_rehearsal.source_appointment(snapshot_hash,id,staff_id,client_id,starts_at,ends_at,payload,context) values(${hash},${a.id}::uuid,${a.staffId}::uuid,${a.clientId}::uuid,${a.startsAt}::timestamptz,${a.endsAt}::timestamptz,${packBooksyJson(a)}::jsonb,${packBooksyJson(context)}::jsonb)`,
      );
    }
    const put = async (
      kind: string,
      sourceId: string,
      raw: unknown,
      table: typeof retailProduct | typeof resourcePool | typeof stockMovement,
      values: Record<string, unknown>,
    ) => {
      const id = sourceUuid(model.businessId, kind, sourceId);
      const existing = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
      if (existing.length) throw new Error("An unmapped native extension already exists");
      const [written] = await tx
        .insert(table)
        .values({ ...values, id } as typeof table.$inferInsert)
        .returning(
          table === stockMovement
            ? sourceStockColumns
            : table === retailProduct
              ? sourceProductColumns
              : getTableColumns(table),
        );
      if (!written) throw new Error("Native extension was not stored");
      await tx.execute(
        sql`insert into booksy_rehearsal.source_entity(snapshot_hash,kind,source_id,target_id,target_hash,raw) values(${hash},${kind},${sourceId},${id}::uuid,${fingerprint(written)},${packBooksyJson(raw)}::jsonb)`,
      );
    };
    for (const raw of model.inventory) {
      const p = z
        .object({
          id: z.number(),
          name: z.string(),
          archived: z.boolean(),
          gross_price: z.string(),
          full_packages_left: z.number().int().nonnegative(),
          total_pack_capacity: z.unknown().optional(),
          volume_unit: z.unknown().optional(),
          product_type: z.string(),
          category_name: z.string().nullable(),
          brand_name: z.string().nullable(),
          barcodes: z.array(z.object({ code: z.string() })),
          tax_rate_value: z.string().nullable(),
          stock_levels: z.array(
            z.object({
              minimum_packages: z.number().int().nonnegative().nullable(),
              maximum_packages: z.number().int().nonnegative().nullable(),
            }),
          ),
        })
        .parse(raw);
      const source = String(p.id),
        key = `booksy:${model.businessId}:${p.id}`,
        requestHash = fingerprint(raw);
      const volumeUnit = z.object({ symbol: z.string() }).safeParse(p.volume_unit);
      const content = packageContentSchema.safeParse({
        quantity:
          typeof p.total_pack_capacity === "number"
            ? String(p.total_pack_capacity)
            : p.total_pack_capacity,
        unit: volumeUnit.data?.symbol,
      });
      await put("sourceProducts", source, raw, retailProduct, {
        name: p.name,
        sku: `BOOKSY-${model.businessId}-${source}`.toUpperCase(),
        barcode: p.barcodes.length === 1 ? p.barcodes[0]!.code : null,
        description:
          p.tax_rate_value === null
            ? "Copia de Booksy: impuesto sin configurar en origen. Producto pendiente de revisión; venta deshabilitada."
            : null,
        category: p.category_name,
        brand: p.brand_name,
        resellable: p.product_type === "r",
        targetStock: p.stock_levels.length === 1 ? p.stock_levels[0]!.maximum_packages : null,
        priceCents: booksyCents(p.gross_price),
        currency: "EUR",
        costCents: null,
        // The required native numeric slot is inert while this incomplete product is disabled.
        // The original null remains in source_entity.raw and the immutable source snapshot.
        taxBasisPoints: p.tax_rate_value === null ? 0 : booksyCents(p.tax_rate_value),
        unitLabel: "envase",
        packageContentQuantity: content.data?.quantity ?? null,
        packageContentUnit: content.data?.unit ?? null,
        active: !p.archived && p.tax_rate_value !== null,
        stockOnHand: p.full_packages_left,
        stockReserved: 0,
        lowStockThreshold:
          p.stock_levels.length === 1 ? (p.stock_levels[0]!.minimum_packages ?? 0) : 0,
        idempotencyKey: key,
        requestHash,
      });
      await put("sourceStockOpening", source, raw, stockMovement, {
        productId: sourceUuid(model.businessId, "sourceProducts", source),
        quantityDelta: p.full_packages_left,
        kind: "opening",
        reason: `Saldo inicial de la copia de Booksy: ${source}`,
        unitCostCents: null,
        idempotencyKey: key,
        requestHash,
      });
    }
    for (const raw of model.resources) {
      const r = z.object({ id: z.number(), name: z.string(), type: z.literal("R") }).parse(raw);
      await put("sourceResources", String(r.id), raw, resourcePool, {
        name: r.name,
        kind: "other",
        capacity: 1,
        active: true,
        idempotencyKey: `booksy:${model.businessId}:${r.id}`,
        requestHash: fingerprint(raw),
      });
    }
  });
  return verifyBooksySourceModel(db, model);
}
export async function verifyBooksySourceModel(
  db: ReadSourceDb,
  model: BooksySourceReadModel,
  options: SourceVerification = {},
) {
  const { desktopTest } = await isolated(db, true);
  const hash = fingerprint(model);
  const doc = await db.execute<{ document: unknown }>(
    sql`select document from booksy_rehearsal.source_snapshot where hash=${hash}`,
  );
  if (doc.length !== 1 || fingerprint(unpackBooksyJson(doc[0]!.document)) !== hash)
    throw new Error("Source snapshot verification failed");
  const rows = await db.execute<{
    id: string;
    payload: unknown;
    context: unknown;
    staff_id: string;
    client_id: string;
    starts_at: Date;
    ends_at: Date;
  }>(
    sql`select id,payload,context,staff_id,client_id,starts_at,ends_at from booksy_rehearsal.source_appointment where snapshot_hash=${hash}`,
  );
  const indexed = new Map(rows.map((r) => [r.id, r]));
  if (rows.length !== model.appointments.length)
    throw new Error("Source appointment count differs");
  for (const a of model.appointments) {
    const r = indexed.get(a.id);
    if (
      !r ||
      fingerprint(unpackBooksyJson(r.payload)) !== fingerprint(a) ||
      fingerprint(unpackBooksyJson(r.context)) !== fingerprint(model.contexts[a.id]) ||
      r.staff_id !== a.staffId ||
      r.client_id !== a.clientId ||
      new Date(r.starts_at).toISOString() !== new Date(a.startsAt).toISOString() ||
      new Date(r.ends_at).toISOString() !== new Date(a.endsAt).toISOString()
    )
      throw new Error("Source appointment fields or private annotations differ");
  }
  const extensions = await db.execute<{
    kind: string;
    source_id: string;
    target_id: string;
    target_hash: string;
    raw: unknown;
  }>(
    sql`select kind,source_id,target_id,target_hash,raw from booksy_rehearsal.source_entity where snapshot_hash=${hash}`,
  );
  const expected = new Map<string, unknown>();
  for (const raw of model.inventory) {
    expected.set(`sourceProducts:${raw.id}`, raw);
    expected.set(`sourceStockOpening:${raw.id}`, raw);
  }
  for (const raw of model.resources) expected.set(`sourceResources:${raw.id}`, raw);
  if (expected.size !== extensions.length)
    throw new Error("Native product/resource mapping counts differ");
  const tables = {
    sourceProducts: retailProduct,
    sourceStockOpening: stockMovement,
    sourceResources: resourcePool,
  };
  for (const r of extensions) {
    const table = tables[r.kind as keyof typeof tables];
    if (
      !table ||
      !expected.has(`${r.kind}:${r.source_id}`) ||
      fingerprint(unpackBooksyJson(r.raw)) !==
        fingerprint(expected.get(`${r.kind}:${r.source_id}`)) ||
      r.target_id !== sourceUuid(model.businessId, r.kind, r.source_id)
    )
      throw new Error("Native source extension mapping differs");
    // The test copy preserves original mappings while allowing edits in the public tables.
    if (!desktopTest || options.exclusiveExtensions) {
      // Backups are verified before migrations as well as after. Read the two
      // optional columns through row JSON so older tables need no schema change.
      const [row] =
        table === retailProduct
          ? await db
              .select({
                ...legacyProductColumns,
                packageContentQuantity: sql<
                  string | null
                >`to_jsonb(${retailProduct})->>'package_content_quantity'`,
                packageContentUnit: sql<
                  string | null
                >`to_jsonb(${retailProduct})->>'package_content_unit'`,
              })
              .from(retailProduct)
              .where(eq(retailProduct.id, r.target_id))
          : table === stockMovement
            ? await db
                .select(sourceStockColumns)
                .from(stockMovement)
                .where(eq(stockMovement.id, r.target_id))
            : await db.select().from(table).where(eq(table.id, r.target_id));
      if (!row || !matchesExtensionFingerprint(row, r.target_hash))
        throw new Error("Native product/resource fields changed");
    }
  }
  if (options.exclusiveExtensions) {
    const [counts] = await db.execute<{
      products: number;
      stockMovements: number;
      stockReservations: number;
      resources: number;
    }>(sql`
      select (select count(*)::int from ${retailProduct}) as products,
             (select count(*)::int from ${stockMovement}) as "stockMovements",
             (select count(*)::int from ${stockReservation}) as "stockReservations",
             (select count(*)::int from ${resourcePool}) as resources
    `);
    if (
      !counts ||
      counts.products !== model.inventory.length ||
      counts.stockMovements !== model.inventory.length ||
      counts.stockReservations !== 0 ||
      counts.resources !== model.resources.length
    )
      throw new Error(
        "The candidate has unexpected products, stock movements or physical resources",
      );
  }
  return {
    hash,
    sourceAppointmentsVerified: true,
    counts: model.summary,
    operationalAppointments: false,
    canCutOver: false,
  };
}
export async function loadBooksySourceModel(
  db: ReadSourceDb,
  hash: string,
  options?: SourceVerification,
) {
  await isolated(db, true);
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Expected an immutable snapshot hash");
  const rows = await db.execute<{ document: BooksySourceReadModel }>(
    sql`select document from booksy_rehearsal.source_snapshot where hash=${hash}`,
  );
  if (rows.length !== 1 || fingerprint(unpackBooksyJson(rows[0]!.document)) !== hash)
    throw new Error("Source snapshot is missing or changed");
  const model = unpackBooksyJson<BooksySourceReadModel>(rows[0]!.document);
  await verifyBooksySourceModel(db, model, options);
  return model;
}
