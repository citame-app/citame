import { z } from "zod";
import { appointmentSchema } from "./appointments";
import { idSchema, instantSchema } from "./common";
import { timeOffSchema } from "./staff";

/** Longest window one calendar request may cover (six weeks). */
export const CALENDAR_MAX_DAYS = 42;

const MS_PER_DAY = 86_400_000;

/**
 * `GET /appointments/calendar`. `staffIds` is a comma-separated list; leave it out for every
 * active staff member the caller may see.
 */
export const calendarQuerySchema = z
  .object({
    from: instantSchema,
    to: instantSchema,
    staffIds: z
      .string()
      .transform((value) => value.split(",").filter((part) => part.length > 0))
      .pipe(
        z
          .array(idSchema)
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length, {
            message: "staffIds must be unique",
          }),
      )
      .optional(),
  })
  .refine((value) => Date.parse(value.to) > Date.parse(value.from), {
    message: "`to` must be after `from`",
    path: ["to"],
  })
  .refine(
    (value) => Date.parse(value.to) - Date.parse(value.from) <= CALENDAR_MAX_DAYS * MS_PER_DAY,
    {
      message: `The range cannot exceed ${CALENDAR_MAX_DAYS} days`,
      path: ["to"],
    },
  );
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarAppointmentSchema = appointmentSchema.extend({
  clientName: z.string(),
  resources: z
    .array(z.object({ name: z.string(), quantity: z.number().int().positive() }))
    .optional(),
  /** In booking order. */
  serviceNames: z.array(z.string()),
});
export type CalendarAppointment = z.infer<typeof calendarAppointmentSchema>;

/** One block of a staff member's recurring hours, resolved to instants in the salon timezone. */
export const workingWindowSchema = z.object({
  staffId: idSchema,
  startsAt: instantSchema,
  endsAt: instantSchema,
});
export type WorkingWindow = z.infer<typeof workingWindowSchema>;

/** Everything a day/week calendar needs in one response. */
export const calendarResponseSchema = z.object({
  timezone: z.string(),
  from: instantSchema,
  to: instantSchema,
  /** The calendar columns, in display order. */
  staff: z.array(z.object({ id: idSchema, displayName: z.string() })),
  /** Appointments overlapping the range, cancelled ones included (check `status`). */
  appointments: z.array(calendarAppointmentSchema),
  timeOff: z.array(timeOffSchema),
  workingWindows: z.array(workingWindowSchema),
});
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;
