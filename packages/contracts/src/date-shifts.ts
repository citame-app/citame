import { z } from "zod";
import { idSchema, instantSchema, localDateSchema } from "./common";
import { scheduleConflictSchema, timeOfDaySchema } from "./staff";

export const dateShiftRangeSchema = z
  .object({ startTime: timeOfDaySchema, endTime: timeOfDaySchema })
  .strict();
export const MAX_DATE_SHIFT_RANGES = 8;
export const dateShiftRangesSchema = z
  .array(dateShiftRangeSchema)
  .max(MAX_DATE_SHIFT_RANGES)
  .superRefine((ranges, ctx) => {
    const sorted = ranges
      .map((range, index) => ({ ...range, index }))
      .sort((a, b) => (a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0));
    for (const [index, range] of ranges.entries())
      if (range.startTime >= range.endTime)
        ctx.addIssue({
          code: "custom",
          path: [index, "endTime"],
          message: "End must follow start",
        });
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1];
      const current = sorted[index];
      if (previous && current && current.startTime < previous.endTime)
        ctx.addIssue({
          code: "custom",
          path: [current.index, "startTime"],
          message: "Shifts must not overlap",
        });
    }
  });
const copySchema = z
  .object({
    mode: z.literal("copy"),
    sourceFrom: localDateSchema,
    days: z.number().int().min(1).max(7),
    targetStarts: z.array(localDateSchema).min(1).max(12),
  })
  .strict();
/** UTC calendar arithmetic deliberately does not use the machine's local timezone. */
export function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export function expandShiftTargets(input: z.infer<typeof copySchema>) {
  return input.targetStarts.flatMap((start) =>
    Array.from({ length: input.days }, (_, day) => ({
      source: shiftDate(input.sourceFrom, day),
      target: shiftDate(start, day),
    })),
  );
}
export const dateShiftInputSchema = z
  .discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("edit"),
        changes: z
          .array(
            z.object({ date: localDateSchema, ranges: dateShiftRangesSchema.nullable() }).strict(),
          )
          .min(1)
          .max(84),
      })
      .strict(),
    copySchema,
  ])
  .superRefine((input, ctx) => {
    const targets =
      input.mode === "copy"
        ? expandShiftTargets(input).map((pair) => pair.target)
        : input.changes.map((change) => change.date);
    if (
      new Set(targets).size !== targets.length ||
      targets.some((date) => !localDateSchema.safeParse(date).success)
    )
      ctx.addIssue({
        code: "custom",
        message: "Choose distinct, non-overlapping valid target dates",
      });
    if (input.mode === "copy") {
      const sources = new Set(
        Array.from({ length: input.days }, (_, index) => shiftDate(input.sourceFrom, index)),
      );
      if (
        [...sources].some((date) => !localDateSchema.safeParse(date).success) ||
        targets.some((date) => sources.has(date))
      )
        ctx.addIssue({ code: "custom", message: "Source and target dates must not overlap" });
    }
  });
export type DateShiftInput = z.infer<typeof dateShiftInputSchema>;
export type DateShiftRange = z.infer<typeof dateShiftRangeSchema>;
const effectiveShiftRangesSchema = z.array(dateShiftRangeSchema).max(56);
export const dateShiftDaySchema = z.object({
  date: localDateSchema,
  version: z.number().int().nonnegative(),
  ranges: dateShiftRangesSchema.nullable(),
  effectiveRanges: effectiveShiftRangesSchema,
});
export const dateShiftsQuerySchema = z
  .object({ from: localDateSchema, to: localDateSchema })
  .strict()
  .superRefine((input, ctx) => {
    const count =
      (Date.parse(`${input.to}T12:00Z`) - Date.parse(`${input.from}T12:00Z`)) / 86400000;
    if (count < 0 || count > 365)
      ctx.addIssue({ code: "custom", message: "Choose an ordered window of up to 366 days" });
  });
export const dateShiftsResponseSchema = z.object({
  staffId: idSchema,
  timezone: z.string(),
  days: z.array(dateShiftDaySchema).max(366),
  conflicts: z.array(scheduleConflictSchema),
});

export function shiftWeekStart(date: string): string {
  return shiftDate(date, -((new Date(`${date}T12:00Z`).getUTCDay() + 6) % 7));
}

export const teamShiftWeekStartSchema = localDateSchema.refine(
  (date) =>
    date >= "0001-01-01" &&
    localDateSchema.safeParse(shiftDate(date, 7)).success &&
    shiftWeekStart(date) === date,
  "Choose a Monday with a full week in range",
);
export const teamShiftWeekQuerySchema = z.object({ week: teamShiftWeekStartSchema }).strict();

export const teamShiftWeekSchema = z.object({
  timezone: z.string(),
  members: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      days: z
        .array(
          z.object({
            date: localDateSchema,
            custom: z.boolean(),
            ranges: effectiveShiftRangesSchema,
            absences: z.array(
              z.object({
                id: idSchema,
                startsAt: instantSchema,
                endsAt: instantSchema,
                fullDay: z.boolean(),
              }),
            ),
          }),
        )
        .length(7),
    }),
  ),
});
export type TeamShiftWeek = z.infer<typeof teamShiftWeekSchema>;
export const dateShiftPreviewSchema = z.object({
  staffId: idSchema,
  timezone: z.string(),
  reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
  changes: z
    .array(
      z.object({ date: localDateSchema, previous: dateShiftDaySchema, next: dateShiftDaySchema }),
    )
    .max(84),
  conflicts: z.array(scheduleConflictSchema),
  withdrawnOffers: z.number().int().nonnegative(),
});
export const dateShiftCommitSchema = z
  .object({
    selection: dateShiftInputSchema,
    reviewHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: idSchema,
  })
  .strict();
export type DateShiftDay = z.infer<typeof dateShiftDaySchema>;
export type DateShiftPreview = z.infer<typeof dateShiftPreviewSchema>;
export type DateShiftCommit = z.infer<typeof dateShiftCommitSchema>;
export const dateShiftResultSchema = dateShiftsResponseSchema.extend({
  replayed: z.boolean(),
  withdrawnOffers: z.number().int().nonnegative(),
});
export type DateShiftResult = z.infer<typeof dateShiftResultSchema>;
