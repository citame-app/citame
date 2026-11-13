import { z } from "zod";
import { idSchema, instantSchema } from "./common";

export const staffSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  serviceIds: z.array(idSchema),
});

export type Staff = z.infer<typeof staffSchema>;

export const listStaffResponseSchema = z.object({ staff: z.array(staffSchema) });
export type ListStaffResponse = z.infer<typeof listStaffResponseSchema>;

/** Staff profile as the dashboard sees it: inactive ones included. */
export const adminStaffSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  active: z.boolean(),
  /** Login account linked to the calendar, if any. */
  userId: z.string().nullable(),
  serviceIds: z.array(idSchema),
});
export type AdminStaff = z.infer<typeof adminStaffSchema>;

export const listAdminStaffResponseSchema = z.object({ staff: z.array(adminStaffSchema) });
export type ListAdminStaffResponse = z.infer<typeof listAdminStaffResponseSchema>;

export const updateStaffRequestSchema = z
  .object({ displayName: z.string().trim().min(1), active: z.boolean() })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["displayName"],
  });
export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;

/** Salon-local wall-clock time, `HH:MM` (24h). Lexicographic order equals chronological order. */
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");

/** 0 = Sunday ... 6 = Saturday. */
export const weekdaySchema = z.number().int().min(0).max(6);

export const workingRangeSchema = z.object({
  weekday: weekdaySchema,
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
});
export type WorkingRange = z.infer<typeof workingRangeSchema>;

/**
 * Replaces the staff member's whole weekly schedule. Weekdays that are not mentioned become
 * days off. Several ranges per weekday are fine (a lunch break); they may touch but not overlap.
 */
export const setWorkingHoursRequestSchema = z
  .object({ hours: z.array(workingRangeSchema).max(7 * 8) })
  .superRefine((value, ctx) => {
    value.hours.forEach((range, index) => {
      if (range.startTime >= range.endTime) {
        ctx.addIssue({
          code: "custom",
          message: "startTime must be before endTime",
          path: ["hours", index, "endTime"],
        });
      }
    });
    const sorted = value.hours
      .map((range, index) => ({ ...range, index }))
      .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      const previous = sorted[i - 1];
      const current = sorted[i];
      if (previous && current && previous.weekday === current.weekday) {
        if (current.startTime < previous.endTime) {
          ctx.addIssue({
            code: "custom",
            message: "Working hours on the same weekday must not overlap",
            path: ["hours", current.index, "startTime"],
          });
        }
      }
    }
  });
export type SetWorkingHoursRequest = z.infer<typeof setWorkingHoursRequestSchema>;

export const conflictReasonSchema = z.enum(["outside_working_hours", "time_off"]);
export type ConflictReason = z.infer<typeof conflictReasonSchema>;

/**
 * An existing appointment that no longer fits a schedule change. Changing hours or time off
 * never moves or cancels bookings; this list lets the UI warn and the owner resolve them.
 */
export const scheduleConflictSchema = z.object({
  appointmentId: idSchema,
  clientId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
  reasons: z.array(conflictReasonSchema).min(1),
});
export type ScheduleConflict = z.infer<typeof scheduleConflictSchema>;

export const workingHoursResponseSchema = z.object({
  staffId: idSchema,
  hours: z.array(workingRangeSchema),
  conflicts: z.array(scheduleConflictSchema),
});
export type WorkingHoursResponse = z.infer<typeof workingHoursResponseSchema>;

export const timeOffSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
  reason: z.string().nullable(),
});
export type TimeOff = z.infer<typeof timeOffSchema>;

const forwardRange = (value: { startsAt?: string; endsAt?: string }) =>
  value.startsAt === undefined ||
  value.endsAt === undefined ||
  Date.parse(value.endsAt) > Date.parse(value.startsAt);

export const createTimeOffRequestSchema = z
  .object({
    startsAt: instantSchema,
    endsAt: instantSchema,
    reason: z.string().trim().min(1).optional(),
  })
  .refine(forwardRange, { message: "`endsAt` must be after `startsAt`", path: ["endsAt"] });
export type CreateTimeOffRequest = z.infer<typeof createTimeOffRequestSchema>;

export const updateTimeOffRequestSchema = z
  .object({
    startsAt: instantSchema,
    endsAt: instantSchema,
    reason: z.string().trim().min(1).nullable(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["startsAt"],
  })
  .refine(forwardRange, { message: "`endsAt` must be after `startsAt`", path: ["endsAt"] });
export type UpdateTimeOffRequest = z.infer<typeof updateTimeOffRequestSchema>;

export const timeOffResponseSchema = z.object({
  timeOff: timeOffSchema,
  conflicts: z.array(scheduleConflictSchema),
});
export type TimeOffResponse = z.infer<typeof timeOffResponseSchema>;

/** Optional window; entries overlapping it are returned. */
export const listTimeOffQuerySchema = z.object({
  from: instantSchema.optional(),
  to: instantSchema.optional(),
});
export type ListTimeOffQuery = z.infer<typeof listTimeOffQuerySchema>;

export const listTimeOffResponseSchema = z.object({ timeOff: z.array(timeOffSchema) });
export type ListTimeOffResponse = z.infer<typeof listTimeOffResponseSchema>;
