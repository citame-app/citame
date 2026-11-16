import { z } from "zod";
import { idSchema, instantSchema } from "./common";

export const CLIENT_CSV_MAX_BYTES = 400000;
export const CLIENT_IMPORT_MAX_ROWS = 500;
export const CLIENT_EXPORT_MAX_ROWS = 5000;
const reviewHash = z.string().regex(/^[a-f0-9]{64}$/);
export const clientImportPreviewInputSchema = z
  .object({
    csv: z
      .string()
      .min(1)
      .max(CLIENT_CSV_MAX_BYTES)
      .refine(
        (value) => new TextEncoder().encode(value).length <= CLIENT_CSV_MAX_BYTES,
        "CSV exceeds the UTF-8 byte limit",
      ),
  })
  .strict();
export const clientImportIssueSchema = z.enum([
  "name",
  "email",
  "phone",
  "notes",
  "tags",
  "contact_required",
]);
export const clientImportRowSchema = z.object({
  row: z.number().int().min(2),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  status: z.enum(["create", "duplicate", "invalid", "ambiguous"]),
  issues: z.array(clientImportIssueSchema),
  matches: z.array(z.object({ id: idSchema, name: z.string() })).max(8),
  duplicateRow: z.number().int().min(2).nullable(),
});
export const clientImportPreviewSchema = z.object({
  reviewHash,
  rows: z.array(clientImportRowSchema).max(CLIENT_IMPORT_MAX_ROWS),
  counts: z.object({
    create: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    invalid: z.number().int().nonnegative(),
    ambiguous: z.number().int().nonnegative(),
  }),
});
export const clientImportInputSchema = clientImportPreviewInputSchema.extend({
  reviewHash,
  idempotencyKey: idSchema,
  rows: z
    .array(
      z
        .number()
        .int()
        .min(2)
        .max(CLIENT_IMPORT_MAX_ROWS + 1),
    )
    .min(1)
    .max(CLIENT_IMPORT_MAX_ROWS)
    .refine((rows) => new Set(rows).size === rows.length, "Choose unique rows"),
});
export const clientImportResultSchema = z.object({
  id: idSchema,
  created: z.number().int().positive(),
  skipped: z.number().int().nonnegative(),
  clientIds: z.array(idSchema).min(1).max(CLIENT_IMPORT_MAX_ROWS),
  importedAt: instantSchema,
});
export const clientExportQuerySchema = z
  .object({ search: z.string().trim().max(100).optional() })
  .strict();
export const clientExportSchema = z.object({
  csv: z.string(),
  count: z.number().int().nonnegative().max(CLIENT_EXPORT_MAX_ROWS),
  exportedAt: instantSchema,
});
export type ClientImportPreview = z.infer<typeof clientImportPreviewSchema>;
export type ClientImportInput = z.infer<typeof clientImportInputSchema>;
export type ClientImportResult = z.infer<typeof clientImportResultSchema>;
export type ClientImportIssue = z.infer<typeof clientImportIssueSchema>;
export type ClientExport = z.infer<typeof clientExportSchema>;
