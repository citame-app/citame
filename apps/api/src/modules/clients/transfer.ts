import { createHash } from "node:crypto";
import {
  CLIENT_EXPORT_MAX_ROWS,
  type ClientExport,
  type ClientImportInput,
  type ClientImportIssue,
  type ClientImportPreview,
  type ClientImportResult,
  clientTagsSchema,
  LIMITS,
  phoneSchema,
} from "@sob/contracts";
import { clientImport, clientProfile, type Database } from "@sob/db";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { searchFilter } from "./admin";
import { readClientCsv, writeClientCsv } from "./transfer-csv";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const contactEmail = (value: string | null) =>
  value?.normalize("NFKC").trim().toLowerCase() || null;
const contactPhone = (value: string | null) => value?.replace(/\D/g, "") || null;
const rowSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(LIMITS.name)
    .regex(/^[^\p{Cc}]+$/u),
  email: z.email().max(LIMITS.email).nullable(),
  phone: phoneSchema.nullable(),
  notes: z.string().max(LIMITS.notes).nullable(),
  tags: clientTagsSchema,
});
type ImportedClient = z.infer<typeof rowSchema>;
type Connection = Database | Tx;

async function prepare(db: Connection, csv: string, lock = false) {
  const parsed = readClientCsv(csv).map((raw) => {
    const input = {
      name: raw.name.normalize("NFKC").trim(),
      email: contactEmail(raw.email),
      phone: raw.phone.trim() || null,
      notes: raw.notes || null,
      tags: raw.tags.trim() ? raw.tags.split(";") : [],
    };
    const result = rowSchema.safeParse(input);
    const issues: ClientImportIssue[] = result.success
      ? []
      : [...new Set(result.error.issues.map((issue) => issue.path[0] as ClientImportIssue))];
    if (!input.email && !input.phone) issues.push("contact_required");
    return { raw, input: result.success && !issues.length ? result.data : null, issues };
  });
  const emails = parsed.flatMap((row) => (row.input?.email ? [row.input.email] : []));
  const phones = parsed.flatMap((row) =>
    row.input?.phone ? [row.input.phone.replace(/\D/g, "")] : [],
  );
  const survivor = alias(clientProfile, "survivor");
  const query = db
    .select({
      id: clientProfile.id,
      name: clientProfile.name,
      email: clientProfile.email,
      phone: clientProfile.phone,
      updatedAt: clientProfile.updatedAt,
      rootId: survivor.id,
      rootName: survivor.name,
    })
    .from(clientProfile)
    .innerJoin(survivor, eq(survivor.id, sql`client_root_id(${clientProfile.id})`))
    .where(
      and(
        isNull(clientProfile.deletedAt),
        isNull(survivor.deletedAt),
        or(
          emails.length
            ? inArray(sql<string>`lower(normalize(btrim(${clientProfile.email}),NFKC))`, emails)
            : undefined,
          phones.length
            ? inArray(
                sql<string>`regexp_replace(${clientProfile.phone}, '[^0-9]', '', 'g')`,
                phones,
              )
            : undefined,
        ),
      ),
    )
    .orderBy(asc(clientProfile.id))
    .limit(CLIENT_EXPORT_MAX_ROWS + 1);
  let existing = emails.length || phones.length ? await query : [];
  if (lock && existing.length) {
    await db
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(inArray(clientProfile.id, [...new Set(existing.map((row) => row.rootId))]))
      .orderBy(asc(clientProfile.id))
      .for("share");
    existing = await query;
  }
  if (existing.length > CLIENT_EXPORT_MAX_ROWS)
    throw new DomainError("validation_error", "Too many repeated contacts; review a smaller file");
  const claimed = new Map<string, number>();
  const contacts = (input: ImportedClient) =>
    [
      input.email ? `email:${input.email}` : null,
      input.phone ? `phone:${contactPhone(input.phone)}` : null,
    ].filter((key): key is string => key !== null);
  const rows: ClientImportPreview["rows"] = parsed.map(({ raw, input, issues }) => {
    const contactsMatched = input
      ? existing.filter(
          (row) =>
            (input.email && contactEmail(row.email) === input.email) ||
            (input.phone && contactPhone(row.phone) === contactPhone(input.phone)),
        )
      : [];
    const matches = [
      ...new Map(
        contactsMatched.map((row) => [row.rootId, { id: row.rootId, name: row.rootName }]),
      ).values(),
    ];
    const priorRows = new Set(
      input
        ? contacts(input).flatMap((key) => {
            const row = claimed.get(key);
            return row === undefined ? [] : [row];
          })
        : [],
    );
    const status = !input
      ? "invalid"
      : matches.length > 1 || priorRows.size > 1
        ? "ambiguous"
        : matches.length || priorRows.size
          ? "duplicate"
          : "create";
    if (status === "create" && input) for (const key of contacts(input)) claimed.set(key, raw.row);
    return {
      row: raw.row,
      name: raw.name.slice(0, LIMITS.name),
      email: raw.email.trim() || null,
      phone: raw.phone.trim() || null,
      status,
      issues,
      matches: matches.slice(0, 8).map(({ id, name }) => ({ id, name })),
      duplicateRow: priorRows.size === 1 ? ([...priorRows][0] ?? null) : null,
    };
  });
  const counts = { create: 0, duplicate: 0, invalid: 0, ambiguous: 0 };
  for (const row of rows) counts[row.status]++;
  const reviewHash = digest({ csv, rows, existing });
  return { preview: { reviewHash, rows, counts } satisfies ClientImportPreview, parsed };
}

export async function previewClientImport(db: Database, csv: string, principal: Principal) {
  requirePermission(principal, "deleteClients");
  return (await prepare(db, csv)).preview;
}
const importView = (row: typeof clientImport.$inferSelect): ClientImportResult => ({
  id: row.id,
  created: row.clientIds.length,
  skipped: row.skipped,
  clientIds: row.clientIds,
  importedAt: row.createdAt.toISOString(),
});

export async function importClients(db: Database, input: ClientImportInput, principal: Principal) {
  requirePermission(principal, "deleteClients");
  const fingerprint = digest({ csv: input.csv, rows: [...input.rows].sort((a, b) => a - b) });
  return db.transaction(async (tx) => {
    // Same coordinator as walk-in booking: contact lookup and profile insertion cannot race.
    await lockScheduling(tx);
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended('sob-client-identity-links-v1',0))`,
    );
    const [previous] = await tx
      .select()
      .from(clientImport)
      .where(
        and(
          eq(clientImport.createdBy, principal.userId),
          eq(clientImport.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (previous) {
      if (previous.requestFingerprint !== fingerprint)
        throw new DomainError(
          "invalid_state",
          "This import identifier already belongs to another selection",
        );
      return importView(previous);
    }
    const { preview, parsed } = await prepare(tx, input.csv, true);
    if (input.reviewHash !== preview.reviewHash)
      throw new DomainError("version_conflict", "The directory changed; review the import again");
    const selected = input.rows.map((number) => {
      const row = preview.rows.find((row) => row.row === number);
      const record = parsed.find((row) => row.raw.row === number);
      if (row?.status !== "create" || !record?.input)
        throw new DomainError("validation_error", "Select only reviewed new client rows");
      return record.input;
    });
    const clients = await tx
      .insert(clientProfile)
      .values(selected)
      .returning({ id: clientProfile.id });
    const [receipt] = await tx
      .insert(clientImport)
      .values({
        createdBy: principal.userId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: fingerprint,
        clientIds: clients.map((c) => c.id),
        skipped: preview.rows.length - clients.length,
      })
      .returning();
    if (!receipt) throw new Error("Import receipt was not created");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "client.import",
      entity: "client_import",
      entityId: receipt.id,
      metadata: { created: clients.length, skipped: receipt.skipped },
    });
    return importView(receipt);
  });
}

export async function exportClients(
  db: Database,
  search: string | undefined,
  principal: Principal,
  now: Date,
): Promise<ClientExport> {
  requirePermission(principal, "deleteClients");
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(clientProfile)
      .where(
        and(
          isNull(clientProfile.deletedAt),
          isNull(clientProfile.mergedIntoId),
          searchFilter(search),
        ),
      )
      .orderBy(asc(clientProfile.name), asc(clientProfile.id))
      .limit(CLIENT_EXPORT_MAX_ROWS + 1);
    if (rows.length > CLIENT_EXPORT_MAX_ROWS)
      throw new DomainError(
        "validation_error",
        "Export supports 5000 clients at once; narrow the directory search",
      );
    const csv = writeClientCsv(
      rows.map((row) => ({
        name: row.name,
        email: row.email ?? "",
        phone: row.phone ?? "",
        notes: row.notes ?? "",
        tags: row.tags.join(";"),
      })),
    );
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "client.export",
      entity: "client",
      metadata: { count: rows.length },
    });
    return { csv, count: rows.length, exportedAt: now.toISOString() };
  });
}
