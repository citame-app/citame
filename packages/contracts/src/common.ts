import { z } from "zod";

export const idSchema = z.uuid();
export const requiredTextSchema = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\u0000"));

export const syncGenerationSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);

/**
 * Maximum lengths of free text a caller can submit. Every request schema that accepts text uses
 * them, so one oversized field cannot bloat rows, sync payloads or notification emails.
 */
export const LIMITS = {
  name: 200,
  phone: 32,
  email: 254,
  notes: 2000,
  description: 2000,
  reason: 500,
} as const;

/** ISO 8601 instant with an explicit offset (usually `Z`). */
export const instantSchema = z.iso.datetime({ offset: true });

/** Calendar date in the salon's local timezone, `YYYY-MM-DD`. */
export const localDateSchema = z.iso.date();

/** 1-based page number from a query string. */
export const pageSchema = z.coerce.number().int().min(1);

/** Page size from a query string, capped at `max`. */
export const pageSizeSchema = (max: number) => z.coerce.number().int().min(1).max(max);

/** Echoes the window of a paged response. */
export const pageInfoSchema = z.object({
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  total: z.number().int().min(0),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;
