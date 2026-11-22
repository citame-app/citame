import { z } from "zod";
import { idSchema, instantSchema, localDateSchema } from "./common";
import type { StaffPermissions } from "./permissions";

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
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
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
const reportClientCounts = z.object({ newClients: count, returningClients: count });
export const REPORT_CLIENT_COLLECTIONS_LIMIT = 10;
export const reportClientsSchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  totals: reportClientCounts,
  rows: z.array(reportClientCounts.extend({ date: localDateSchema })),
  groups: z.array(z.object({ name: z.string().min(1), clients: count })).optional(),
  frequency: z.object({ one: count, two: count, threeOrMore: count }).optional(),
  /** Positive external collections net of recorded refunds, in checkout currency (EUR). */
  topCollections: z
    .array(
      z.object({ clientId: idSchema, name: z.string(), netCents: z.number().int().positive() }),
    )
    .max(REPORT_CLIENT_COLLECTIONS_LIMIT)
    .optional(),
});
export type ReportClients = z.infer<typeof reportClientsSchema>;
export const reportOutcomeSchema = z.enum(["cancelled", "no_show"]);
export type ReportOutcome = z.infer<typeof reportOutcomeSchema>;
export const reportOutcomesQuerySchema = reportQuerySchema.safeExtend({
  status: reportOutcomeSchema,
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
});
export type ReportOutcomesQuery = z.infer<typeof reportOutcomesQuerySchema>;
export const reportOutcomeRowSchema = z.object({
  id: idSchema,
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  client: z.string().nullable(),
  staff: z.string(),
  services: z.array(z.string()),
});
export type ReportOutcomeRow = z.infer<typeof reportOutcomeRowSchema>;
export const reportOutcomesPageSchema = z.object({
  rows: z.array(reportOutcomeRowSchema),
  total: count,
  page: count,
  pageSize: count,
  timezone: z.string(),
});

export const statusCountsSchema = z.object({
  booked: count,
  completed: count,
  cancelled: count,
  no_show: count,
});
export type StatusCounts = z.infer<typeof statusCountsSchema>;

export const reportBreakdownKinds = ["hour", "service", "category", "addon"] as const;
export type ReportBreakdownKind = (typeof reportBreakdownKinds)[number];
export const reportBreakdownRowSchema = z.object({
  key: z.string(),
  /** Null identifies appointments whose service has no recorded category. */
  label: z.string().nullable(),
  appointments: count,
  byStatus: statusCountsSchema,
});
export type ReportBreakdownRow = z.infer<typeof reportBreakdownRowSchema>;

/** Share of no-shows among appointments that should have happened; null when there were none. */
const rateSchema = z.number().min(0).max(1).nullable();

export const reportSliceSchema = z.object({
  appointments: z.number().int().min(0),
  byStatus: statusCountsSchema,
  /** Sum of known prices of completed appointment services, in the minor currency unit. */
  revenueCents: z.number().int().min(0),
  /** Completed service lines omitted from the amount while their original price is unknown. */
  unpricedServices: z.number().int().positive().optional(),
});

const staffOccupancySchema = z.object({
  scheduledMinutes: count,
  blockedMinutes: count,
  reservedMinutes: count,
  completedMinutes: count,
  noShowMinutes: count,
  occupancyRate: rateSchema,
});
export type StaffOccupancy = z.infer<typeof staffOccupancySchema>;

export const reportStaffWorkQuerySchema = reportQuerySchema.safeExtend({ staffId: idSchema });
export const reportStaffWorkDaySchema = staffOccupancySchema.extend({ date: localDateSchema });
export type ReportStaffWorkDay = z.infer<typeof reportStaffWorkDaySchema>;
const reportStaffWorkPeriodSchema = z.object({
  from: localDateSchema,
  to: localDateSchema,
  totals: staffOccupancySchema,
  days: z.array(reportStaffWorkDaySchema).max(REPORT_MAX_DAYS),
  unavailable: z.array(z.object({ startsAt: instantSchema, endsAt: instantSchema })),
});
export type ReportStaffWorkPeriod = z.infer<typeof reportStaffWorkPeriodSchema>;
export const reportStaffWorkSchema = z.object({
  staffId: idSchema,
  timezone: z.string(),
  selected: reportStaffWorkPeriodSchema,
  upcoming: reportStaffWorkPeriodSchema,
});
export type ReportStaffWork = z.infer<typeof reportStaffWorkSchema>;

export const reportSummaryQuerySchema = reportQuerySchema.safeExtend({
  businessOverview: z.literal("1").optional(),
});
export type ReportSummaryQuery = z.infer<typeof reportSummaryQuerySchema>;

export function canViewBusinessOverview(access: StaffPermissions) {
  return (
    access.financialReports &&
    access.clients &&
    access.commerce &&
    access.allSales &&
    access.readInventory
  );
}

export const reportBusinessOverviewSchema = z.object({
  visitingClients: count,
  occupancyRate: rateSchema,
  /** Recorded external collections minus recorded refunds, in EUR. */
  netCollectedCents: z.number().int(),
  /** Active products across the centre with available stock at or below threshold now. */
  lowStockProducts: count,
});
export type ReportBusinessOverview = z.infer<typeof reportBusinessOverviewSchema>;

export const reportSummarySchema = z.object({
  canReportClients: z.boolean().optional(),
  businessOverview: reportBusinessOverviewSchema.optional(),
  from: localDateSchema,
  to: localDateSchema,
  timezone: z.string(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).optional(),
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
      unpricedServices: z.number().int().positive().optional(),
    }),
  ),
  perStaff: z.array(
    reportSliceSchema.extend({
      staffId: idSchema,
      displayName: z.string(),
      noShowRate: rateSchema,
      occupancy: staffOccupancySchema.optional(),
    }),
  ),
  appointmentBreakdown: z
    .record(z.enum(reportBreakdownKinds), z.array(reportBreakdownRowSchema))
    .optional(),
  /** Appointment outcomes grouped by the offer name and code reviewed at booking. */
  promotionBreakdown: z.array(reportBreakdownRowSchema).optional(),
});
export type ReportSummary = z.infer<typeof reportSummarySchema>;
