import { createHash } from "node:crypto";
import { auditLog } from "@sob/db";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "../../tx";

export const booksyPaymentEvidenceAudit = "appointment.booksy_payment_evidence_corrected";

export function booksyPaymentSourceDigest(sourceRef: string) {
  return createHash("sha256").update(sourceRef).digest("hex");
}

const paymentFlagsSchema = z.object({
  paid: z.boolean().nullable(),
  invoiced: z.boolean().nullable(),
  sourcePaymentUnverified: z.boolean(),
});
export type BooksyPaymentFlags = z.infer<typeof paymentFlagsSchema>;

const correctionSchema = z.object({
  contextId: z.uuid(),
  contextVersion: z.number().int().positive(),
  sourceRefDigest: z.string().regex(/^[a-f0-9]{64}$/),
  before: paymentFlagsSchema,
  after: paymentFlagsSchema,
});

export function sameBooksyPaymentFlags(a: BooksyPaymentFlags, b: BooksyPaymentFlags) {
  return (
    a.paid === b.paid &&
    a.invoiced === b.invoiced &&
    a.sourcePaymentUnverified === b.sourcePaymentUnverified
  );
}

/** Replays reviewed flag changes from the archive to the current imported service row. */
export async function verifyBooksyPaymentCorrections(
  tx: Tx,
  contexts: (BooksyPaymentFlags & {
    id: string;
    appointmentId: string;
    version: number;
    sourceRef: string | null;
  })[],
  archivedFlags: ReadonlyMap<string, BooksyPaymentFlags>,
) {
  const actual = new Map(contexts.map((row) => [row.id, row]));
  const records = await tx
    .select({ appointmentId: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(eq(auditLog.entity, "appointment"), eq(auditLog.action, booksyPaymentEvidenceAudit)),
    );
  const mismatch = () => new Error("Imported payment audit differs from the archived services");
  const changes = records.map(({ appointmentId, metadata }) => {
    const parsed = correctionSchema.safeParse(metadata);
    if (!parsed.success) throw mismatch();
    const row = actual.get(parsed.data.contextId);
    if (
      !row?.sourceRef ||
      row.appointmentId !== appointmentId ||
      parsed.data.sourceRefDigest !== booksyPaymentSourceDigest(row.sourceRef)
    )
      throw mismatch();
    return parsed.data;
  });
  const verified = new Map<string, { flags: BooksyPaymentFlags; version: number }>();
  for (const change of changes.sort((a, b) => a.contextVersion - b.contextVersion)) {
    const previous = verified.get(change.contextId);
    const before = previous?.flags ?? archivedFlags.get(change.contextId);
    if (
      !before ||
      change.contextVersion <= (previous?.version ?? 1) ||
      !sameBooksyPaymentFlags(change.before, before) ||
      sameBooksyPaymentFlags(change.before, change.after)
    )
      throw mismatch();
    verified.set(change.contextId, { flags: change.after, version: change.contextVersion });
  }
  for (const row of contexts) {
    const correction = verified.get(row.id);
    const expected = correction?.flags ?? archivedFlags.get(row.id);
    if (
      !expected ||
      (correction && correction.version > row.version) ||
      !sameBooksyPaymentFlags(row, expected)
    )
      throw mismatch();
  }
}
