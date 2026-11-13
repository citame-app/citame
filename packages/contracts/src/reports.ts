import { z } from "zod";
import { idSchema, localDateSchema } from "./common";

/** Longest reportable window, in calendar days (both ends inclusive). */
export const REPORT_MAX_DAYS = 366;

const MS_PER_DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY;

/**
 * `from` and `to` are salon-local calendar dates, both inclusive. Appointments are bucketed by
 * the local date they start on, so an evening booking never leaks into the next UTC day.
 */
export const reportQuerySchema = z
  .object({
    from: localDateSchema,
    to: localDateSchema,
    staffId: idSchema.optional(),
  })
  .refine((value) => daysBetween(value.from, value.to) >= 0, {
    message: "`to` must not be before `from`",
    path: ["to"],
  })
  .refine((value) => daysBetween(value.from, value.to) < REPORT_MAX_DAYS, {
    message: `The range cannot exceed ${REPORT_MAX_DAYS} days`,
    path: ["to"],
  });
export type ReportQuery = z.infer<typeof reportQuerySchema>;

const count = z.number().int().min(0);
export const statusCountsSchema = z.object({
  booked: count,
  completed: count,
  cancelled: count,
  no_show: count,
});
export type StatusCounts = z.infer<typeof statusCountsSchema>;

/** Share of no-shows among appointments that should have happened; null when there were none. */
const rateSchema = z.number().min(0).max(1).nullable();

export const reportSliceSchema = z.object({
  appointments: z.number().int().min(0),
  byStatus: statusCountsSchema,
  /** Sum of price snapshots of completed appointments, in the minor currency unit. */
  revenueCents: z.number().int().min(0),
});

export const reportSummarySchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  timezone: z.string(),
  /** The staff member the report is limited to, if any. */
  staffId: idSchema.nullable(),
  totals: reportSliceSchema.extend({
    /** no_show / (completed + no_show). */
    noShowRate: rateSchema,
  }),
  /** One entry per local date in the range, zero-filled. */
  series: z.array(reportSliceSchema.extend({ date: localDateSchema })),
  /** Completed services, ranked by count then revenue. */
  topServices: z.array(
    z.object({
      serviceId: idSchema.nullable(),
      name: z.string(),
      count: z.number().int().min(0),
      revenueCents: z.number().int().min(0),
    }),
  ),
  perStaff: z.array(
    reportSliceSchema.extend({
      staffId: idSchema,
      displayName: z.string(),
      noShowRate: rateSchema,
    }),
  ),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;
