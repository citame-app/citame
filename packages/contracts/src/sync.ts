import { z } from "zod";
import { appointmentSchema, createAppointmentBaseSchema } from "./appointments";
import { calendarAppointmentSchema } from "./calendar";
import { idSchema, instantSchema, LIMITS, localDateSchema, syncGenerationSchema } from "./common";
import { dateShiftRangesSchema } from "./date-shifts";
import { salonResponseSchema, updateSalonSettingsRequestSchema } from "./salon";
import { serviceSchema, updateServiceRequestSchema } from "./services";
import { timeOfDaySchema, timeOffSchema, weekdaySchema } from "./staff";

/**
 * Offline sync protocol (ADR 0007, docs/sync-protocol.md). Everything a desktop client sends or
 * receives is defined here; the Rust client implements the same shapes by hand.
 */

export const SYNC_PUSH_MAX_MUTATIONS = 100;
export const SYNC_PULL_LIMIT_DEFAULT = 200;
export const SYNC_PULL_LIMIT_MAX = 500;

/** Client-generated idempotency key. UUIDv7 so ids sort by creation time. */
export const mutationIdSchema = z.uuidv7();

/** Entities announced by pull, by wire name. */
export const syncEntitySchema = z.enum([
  "appointment",
  "client",
  "service",
  "staff",
  "service_staff",
  "working_hours",
  "date_shift",
  "time_off",
  "salon_settings",
]);
export type SyncEntity = z.infer<typeof syncEntitySchema>;

// ---------------------------------------------------------------------------------------------
// Mutations (push)
// ---------------------------------------------------------------------------------------------

const envelope = {
  mutationId: mutationIdSchema,
  /**
   * When the user made the edit, on the device clock. Last-writer-wins kinds compare it with the
   * row's `updatedAt`; the server clamps it to its own clock, so a skewed device cannot win
   * forever. Appointments are server-authoritative and ignore it.
   */
  createdAt: instantSchema,
};

const exactlyOneClient = (value: { clientId?: string; client?: unknown }) =>
  (value.clientId === undefined) !== (value.client === undefined);

const oneChange = (value: Record<string, unknown>) =>
  Object.entries(value).some(([key, v]) => key !== "id" && key !== "staffId" && v !== undefined);

const appointmentCreate = z.object({
  ...envelope,
  kind: z.literal("appointment.create"),
  /** The id is mandatory: offline clients pre-assign it so later mutations can refer to it. */
  payload: createAppointmentBaseSchema.extend({ id: idSchema }).refine(exactlyOneClient, {
    message: "Provide exactly one of clientId or client",
    path: ["clientId"],
  }),
});

const appointmentReschedule = z.object({
  ...envelope,
  kind: z.literal("appointment.reschedule"),
  payload: z
    .object({
      id: idSchema,
      /** The appointment version the device last saw; a stale one is rejected with `conflict`. */
      version: z.number().int().positive(),
      startsAt: instantSchema.optional(),
      staffId: idSchema.optional(),
      notes: z.string().max(LIMITS.notes).optional(),
      override: z.boolean().optional(),
    })
    .refine((v) => v.startsAt !== undefined || v.staffId !== undefined, {
      message: "Provide startsAt and/or staffId",
      path: ["startsAt"],
    }),
});

const appointmentCancel = z.object({
  ...envelope,
  kind: z.literal("appointment.cancel"),
  payload: z.object({ id: idSchema, version: z.number().int().positive() }),
});

const appointmentSetStatus = z.object({
  ...envelope,
  kind: z.literal("appointment.set_status"),
  payload: z.object({
    id: idSchema,
    version: z.number().int().positive(),
    status: z.enum(["completed", "no_show"]),
    notes: z.string().max(LIMITS.notes).optional(),
  }),
});

const clientCreate = z.object({
  ...envelope,
  kind: z.literal("client.create"),
  payload: z.object({
    id: idSchema,
    name: z.string().trim().min(1).max(LIMITS.name),
    phone: z.string().trim().min(3).max(LIMITS.phone).optional(),
    email: z.email().max(LIMITS.email).optional(),
    notes: z.string().max(LIMITS.notes).optional(),
  }),
});

const clientUpdate = z.object({
  ...envelope,
  kind: z.literal("client.update"),
  payload: z
    .object({
      id: idSchema,
      expectedUpdatedAt: instantSchema.optional(),
      name: z.string().trim().min(1).max(LIMITS.name).optional(),
      phone: z.string().trim().min(3).max(LIMITS.phone).nullable().optional(),
      notes: z.string().max(LIMITS.notes).nullable().optional(),
    })
    .refine(({ expectedUpdatedAt: _, ...changes }) => oneChange(changes), {
      message: "Provide at least one change",
      path: ["name"],
    }),
});

const timeOffCreate = z.object({
  ...envelope,
  kind: z.literal("time_off.create"),
  payload: z
    .object({
      id: idSchema,
      staffId: idSchema,
      startsAt: instantSchema,
      endsAt: instantSchema,
      reason: z.string().trim().min(1).max(LIMITS.reason).optional(),
    })
    .refine((v) => Date.parse(v.endsAt) > Date.parse(v.startsAt), {
      message: "`endsAt` must be after `startsAt`",
      path: ["endsAt"],
    }),
});

const timeOffUpdate = z.object({
  ...envelope,
  kind: z.literal("time_off.update"),
  payload: z
    .object({
      id: idSchema,
      staffId: idSchema,
      expectedUpdatedAt: instantSchema.optional(),
      startsAt: instantSchema.optional(),
      endsAt: instantSchema.optional(),
      reason: z.string().trim().min(1).max(LIMITS.reason).nullable().optional(),
    })
    .refine(
      ({ startsAt, endsAt, reason }) =>
        startsAt !== undefined || endsAt !== undefined || reason !== undefined,
      { message: "Provide at least one change", path: ["startsAt"] },
    ),
});

const timeOffDelete = z.object({
  ...envelope,
  kind: z.literal("time_off.delete"),
  payload: z.object({
    id: idSchema,
    staffId: idSchema,
    expectedUpdatedAt: instantSchema.optional(),
  }),
});

const serviceUpdate = z.object({
  ...envelope,
  kind: z.literal("service.update"),
  payload: z
    .object({ id: idSchema, ...updateServiceRequestSchema.shape })
    .refine(oneChange, { message: "Provide at least one change", path: ["name"] }),
});

const staffUpdate = z.object({
  ...envelope,
  kind: z.literal("staff.update"),
  payload: z
    .object({
      id: idSchema,
      displayName: z.string().trim().min(1).max(LIMITS.name).optional(),
      active: z.boolean().optional(),
    })
    .refine(oneChange, { message: "Provide at least one change", path: ["displayName"] }),
});

const settingsUpdate = z.object({
  ...envelope,
  kind: z.literal("settings.update"),
  payload: updateSalonSettingsRequestSchema,
});

export const syncMutationSchema = z.discriminatedUnion("kind", [
  appointmentCreate,
  appointmentReschedule,
  appointmentCancel,
  appointmentSetStatus,
  clientCreate,
  clientUpdate,
  timeOffCreate,
  timeOffUpdate,
  timeOffDelete,
  serviceUpdate,
  staffUpdate,
  settingsUpdate,
]);
export type SyncMutation = z.infer<typeof syncMutationSchema>;
export type SyncMutationKind = SyncMutation["kind"];

export const initialSyncGeneration = "initial";
export { syncGenerationSchema } from "./common";

/**
 * What the server validates first: the envelope only. Each mutation body is then validated on
 * its own, so one malformed mutation is rejected as `invalid` without failing the whole batch.
 */
export const syncPushRequestSchema = z.object({
  /** Stable per-installation identifier; informational (audit and diagnostics). */
  deviceId: z.string().trim().min(1).max(100),
  generation: syncGenerationSchema.optional(),
  mutations: z
    .array(z.object({ mutationId: mutationIdSchema }).loose())
    .min(1)
    .max(SYNC_PUSH_MAX_MUTATIONS),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;

/** The fully typed batch a client builds before sending it. */
export const syncPushBatchSchema = z.object({
  deviceId: syncPushRequestSchema.shape.deviceId,
  generation: syncPushRequestSchema.shape.generation,
  mutations: z.array(syncMutationSchema).min(1).max(SYNC_PUSH_MAX_MUTATIONS),
});
export type SyncPushBatch = z.infer<typeof syncPushBatchSchema>;

export const syncRejectReasonSchema = z.enum([
  /** Another appointment already holds the slot (exclusion constraint). */
  "slot_taken",
  /** Outside working hours, during time off, or breaking the notice/advance window. */
  "slot_unavailable",
  "forbidden",
  /** Malformed mutation, unknown kind, or a business rule such as a bad reference. */
  "invalid",
  /** A newer version of the row exists (stale appointment version, or last-writer-wins loss). */
  "conflict",
  "not_found",
  /** The row is in a state that does not allow the change (for example a cancelled appointment). */
  "invalid_state",
  /** A human must complete the current published forms before retrying this proposal. */
  "intake_required",
  "booking_intent_conflict",
]);
export type SyncRejectReason = z.infer<typeof syncRejectReasonSchema>;

export const syncMutationResultSchema = z.discriminatedUnion("status", [
  z.object({
    mutationId: mutationIdSchema,
    status: z.literal("applied"),
    /** Last change seq the mutation wrote; null when it changed nothing. Pull until the cursor reaches it. */
    appliedSeq: z.number().int().min(0).nullable(),
    /** True when this is the stored result of an earlier delivery of the same mutation. */
    replayed: z.boolean(),
  }),
  z.object({
    mutationId: mutationIdSchema,
    status: z.literal("rejected"),
    reason: syncRejectReasonSchema,
    message: z.string(),
    replayed: z.boolean(),
  }),
  z.object({
    mutationId: mutationIdSchema,
    /** Transient failure; nothing was stored. Resend the same mutation with backoff. */
    status: z.literal("retry"),
    message: z.string(),
  }),
]);
export type SyncMutationResult = z.infer<typeof syncMutationResultSchema>;

export const syncPushResponseSchema = z.object({
  /** One result per mutation, in request order. */
  results: z.array(syncMutationResultSchema),
  /** Highest committed seq at the end of the batch. */
  headSeq: z.number().int().min(0),
});
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

// ---------------------------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------------------------

export const syncPullQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(SYNC_PULL_LIMIT_MAX).default(SYNC_PULL_LIMIT_DEFAULT),
  catalogColors: z.literal("1").optional(),
  reviewRequests: z.literal("1").optional(),
  intakeViews: z.literal("1").optional(),
});
export type SyncPullQuery = z.infer<typeof syncPullQuerySchema>;

export const syncClientSchema = z.object({
  id: idSchema,
  mergedIntoId: idSchema.nullable().optional(),
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type SyncClient = z.infer<typeof syncClientSchema>;

export const syncServiceSchema = serviceSchema.safeExtend({
  active: z.boolean(),
  updatedAt: instantSchema,
});
export type SyncService = z.infer<typeof syncServiceSchema>;

export const syncStaffSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(6).optional(),
  id: idSchema,
  displayName: z.string(),
  active: z.boolean(),
  /** Login account; only the owner receives it. */
  userId: z.string().nullable(),
  updatedAt: instantSchema,
});
export type SyncStaff = z.infer<typeof syncStaffSchema>;

export const syncServiceStaffSchema = z.object({
  id: idSchema,
  serviceId: idSchema,
  staffId: idSchema,
});
export type SyncServiceStaff = z.infer<typeof syncServiceStaffSchema>;

export const syncWorkingHoursSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  weekday: weekdaySchema,
  startTime: timeOfDaySchema,
  endTime: timeOfDaySchema,
});
export type SyncWorkingHours = z.infer<typeof syncWorkingHoursSchema>;
export const syncDateShiftSchema = z.object({
  id: idSchema,
  staffId: idSchema,
  date: localDateSchema,
  ranges: dateShiftRangesSchema.nullable(),
  version: z.number().int().positive(),
  updatedAt: instantSchema,
});
export type SyncDateShift = z.infer<typeof syncDateShiftSchema>;

export const syncTimeOffSchema = timeOffSchema.extend({ updatedAt: instantSchema });
export type SyncTimeOff = z.infer<typeof syncTimeOffSchema>;

export const syncSalonSettingsSchema = salonResponseSchema.extend({ updatedAt: instantSchema });
export type SyncSalonSettings = z.infer<typeof syncSalonSettingsSchema>;

const upsert = <E extends string, S extends z.ZodType>(entity: E, data: S) =>
  z.object({
    seq: z.number().int().min(1),
    entity: z.literal(entity),
    id: z.string(),
    op: z.literal("upsert"),
    data,
  });

const upsertChangeSchema = z.discriminatedUnion("entity", [
  // Optional enrichment for web live notifications; existing clients keep the same fields.
  upsert(
    "appointment",
    appointmentSchema.extend({
      clientName: z.string().optional(),
      ...calendarAppointmentSchema.pick({
        billingReviewReasons: true,
        externallySettled: true,
        externalBalance: true,
        importedFromBooksy: true,
        serviceBadges: true,
      }).shape,
    }),
  ),
  upsert("client", syncClientSchema),
  upsert("service", syncServiceSchema),
  upsert("staff", syncStaffSchema),
  upsert("service_staff", syncServiceStaffSchema),
  upsert("working_hours", syncWorkingHoursSchema),
  upsert("date_shift", syncDateShiftSchema),
  upsert("time_off", syncTimeOffSchema),
  upsert("salon_settings", syncSalonSettingsSchema),
]);

/**
 * A tombstone: the row was deleted, or it is not visible to this caller (anymore). Clients
 * delete their local copy; applying it twice is harmless.
 */
const tombstoneSchema = z.object({
  seq: z.number().int().min(1),
  entity: syncEntitySchema,
  id: z.string(),
  op: z.literal("delete"),
  data: z.null(),
});

export const syncChangeSchema = z.union([upsertChangeSchema, tombstoneSchema]);
export type SyncChange = z.infer<typeof syncChangeSchema>;

export const syncLiveViewSchema = z.enum([
  "commerce",
  "waitlist",
  "inbox",
  "review_requests",
  "intake_forms",
  "intake_records",
]);
export type SyncLiveView = z.infer<typeof syncLiveViewSchema>;

export const syncPullResponseSchema = z.object({
  generation: syncGenerationSchema.optional(),
  /** Online views to reload from their permission-scoped endpoints. No row data is included. */
  refresh: z.array(syncLiveViewSchema).optional(),
  /** Configured service colors for upgrading replicas that lacked the color field. */
  catalogColors: z.record(idSchema, z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional(),
  changes: z.array(syncChangeSchema),
  /** Store this and send it as `since` next time. Never decreases. */
  nextCursor: z.number().int().min(0),
  /** True when more changes are already available beyond `nextCursor`: pull again immediately. */
  hasMore: z.boolean(),
  /** Highest committed seq the server could see when it answered. */
  headSeq: z.number().int().min(0),
  /** Time off the current caller can manage: none, every calendar, or their own staff ID. */
  timeOffScope: z.union([z.literal("none"), z.literal("all"), idSchema]).optional(),
  clientDirectory: z.boolean().optional(),
  viewerRole: z.enum(["owner", "staff"]).optional(),
  calendarScope: z.union([z.literal("none"), z.literal("all"), idSchema]).optional(),
});
export type SyncPullResponse = z.infer<typeof syncPullResponseSchema>;

/** Payload of the `change` event on `GET /sync/stream`: "something new exists, pull". */
export const syncNudgeSchema = z.object({ seq: z.number().int().min(0) });
export type SyncNudge = z.infer<typeof syncNudgeSchema>;
