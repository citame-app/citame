import { z } from "zod";
import { idSchema, LIMITS } from "./common";
import {
  serviceCatalogCreateSchema,
  serviceCatalogSchema,
  serviceCatalogUpdateSchema,
} from "./service-options";

export const serviceSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    durationMinutes: z.number().int().nonnegative(),
    bufferMinutes: z.number().int().min(0),
    priceCents: z.number().int().min(0),
    currency: z.string().length(3),
    catalog: serviceCatalogSchema.optional(),
  })
  .refine((s) => s.durationMinutes > 0 || s.catalog?.kind === "addon", {
    message: "A standalone service needs a positive duration",
    path: ["durationMinutes"],
  });

export type Service = z.infer<typeof serviceSchema>;

export const listServicesResponseSchema = z.object({ services: z.array(serviceSchema) });
export type ListServicesResponse = z.infer<typeof listServicesResponseSchema>;

/** What the dashboard sees: the public fields plus activation state and who performs it. */
export const adminServiceSchema = serviceSchema.safeExtend({
  active: z.boolean(),
  staffIds: z.array(idSchema),
  version: z.number().int().positive().optional(),
});
export type AdminService = z.infer<typeof adminServiceSchema>;

export const listAdminServicesResponseSchema = z.object({ services: z.array(adminServiceSchema) });
export type ListAdminServicesResponse = z.infer<typeof listAdminServicesResponseSchema>;

const MAX_DURATION_MINUTES = 24 * 60;

const serviceFields = {
  name: z.string().trim().min(1).max(LIMITS.name),
  description: z.string().max(LIMITS.description).nullable(),
  durationMinutes: z.number().int().nonnegative().max(MAX_DURATION_MINUTES),
  bufferMinutes: z.number().int().min(0).max(MAX_DURATION_MINUTES),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
};

/** Owner-only. The service starts active; staff are assigned with a separate call. */
export const createServiceRequestSchema = z
  .object({
    name: serviceFields.name,
    description: serviceFields.description.optional(),
    durationMinutes: serviceFields.durationMinutes,
    bufferMinutes: serviceFields.bufferMinutes.optional(),
    priceCents: serviceFields.priceCents,
    currency: serviceFields.currency.optional(),
    catalog: serviceCatalogCreateSchema.optional(),
    staffIds: z
      .array(idSchema)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, { message: "Staff must be unique" })
      .optional(),
  })
  .refine((s) => s.durationMinutes > 0 || s.catalog?.kind === "addon", {
    message: "A standalone service needs a positive duration",
    path: ["durationMinutes"],
  });
export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = z
  .object({
    name: serviceFields.name,
    description: serviceFields.description,
    durationMinutes: serviceFields.durationMinutes,
    bufferMinutes: serviceFields.bufferMinutes,
    priceCents: serviceFields.priceCents,
    currency: serviceFields.currency,
    active: z.boolean(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["name"],
  });
export type UpdateServiceRequest = z.infer<typeof updateServiceRequestSchema>;

/** Replaces the whole set of staff who perform a service. */
export const setServiceStaffRequestSchema = z.object({
  staffIds: z.array(idSchema).refine((ids) => new Set(ids).size === ids.length, {
    message: "staffIds must be unique",
  }),
});
export type SetServiceStaffRequest = z.infer<typeof setServiceStaffRequestSchema>;

export const serviceConfigurationSchema = z
  .object({
    version: z.number().int().positive(),
    service: updateServiceRequestSchema,
    staffIds: z
      .array(idSchema)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, { message: "Staff must be unique" }),
    catalog: serviceCatalogUpdateSchema.optional(),
  })
  .strict();
export type ServiceConfiguration = z.infer<typeof serviceConfigurationSchema>;
