import { z } from "zod";
import { idSchema, LIMITS, syncGenerationSchema } from "./common";
import {
  serviceCatalogCreateSchema,
  serviceCatalogSchema,
  serviceCatalogUpdateSchema,
} from "./service-options";
import { servicePriceTypeSchema } from "./service-pricing";
import { processingTimeSchema } from "./staff-capacity";

export const SERVICE_CATEGORY_MAX_LENGTH = 100;

const presentationFields = {
  bookingIntervalMinutes: z.number().int().min(1).max(120).nullable().optional(),
  category: z.string().trim().min(1).max(SERVICE_CATEGORY_MAX_LENGTH).nullable().optional(),
  sortOrder: z.number().int().min(0).max(100000).optional(),
  onlineBooking: z.boolean().optional(),
  clientInstructions: z.string().trim().max(2000).nullable().optional(),
};

export const serviceSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    description: z.string().nullable(),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullable()
      .optional(),
    durationMinutes: z.number().int().nonnegative(),
    bufferMinutes: z.number().int().min(0),
    processing: processingTimeSchema.optional(),
    priceCents: z.number().int().min(0),
    priceType: servicePriceTypeSchema.optional(),
    currency: z.string().length(3),
    catalog: serviceCatalogSchema.optional(),
    ...presentationFields,
    quoteHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .refine((s) => s.durationMinutes > 0 || s.catalog?.kind === "addon", {
    message: "A standalone service needs a positive duration",
    path: ["durationMinutes"],
  })
  .refine((s) => !["variable", "free"].includes(s.priceType ?? "fixed") || s.priceCents === 0, {
    message: "An unknown or free price has no fixed charge",
    path: ["priceCents"],
  })
  .refine(
    (s) =>
      !s.processing || s.processing.startsAfterMinutes + s.processing.minutes < s.durationMinutes,
    { message: "Processing requires final hands-on work", path: ["processing"] },
  );

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
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable(),
  durationMinutes: z.number().int().nonnegative().max(MAX_DURATION_MINUTES),
  bufferMinutes: z.number().int().min(0).max(MAX_DURATION_MINUTES),
  priceCents: z.number().int().min(0),
  priceType: servicePriceTypeSchema.optional(),
  currency: z.string().length(3),
};

/** Owner-only. The service starts active; staff are assigned with a separate call. */
export const createServiceRequestSchema = z
  .object({
    name: serviceFields.name,
    ...presentationFields,
    processing: processingTimeSchema.nullable().optional(),
    description: serviceFields.description.optional(),
    color: serviceFields.color.optional(),
    durationMinutes: serviceFields.durationMinutes,
    bufferMinutes: serviceFields.bufferMinutes.optional(),
    priceCents: serviceFields.priceCents.optional(),
    priceType: serviceFields.priceType,
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
  })
  .refine(
    (s) => s.priceCents !== undefined || s.priceType === "variable" || s.priceType === "free",
    { message: "Enter a price", path: ["priceCents"] },
  )
  .refine((s) => !["variable", "free"].includes(s.priceType ?? "fixed") || !s.priceCents, {
    message: "Variable and free services do not have a fixed price",
    path: ["priceCents"],
  });
export type CreateServiceRequest = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = z
  .object({
    name: serviceFields.name,
    ...presentationFields,
    processing: processingTimeSchema.nullable().optional(),
    description: serviceFields.description,
    color: serviceFields.color,
    durationMinutes: serviceFields.durationMinutes,
    bufferMinutes: serviceFields.bufferMinutes,
    priceCents: serviceFields.priceCents,
    priceType: serviceFields.priceType,
    currency: serviceFields.currency,
    active: z.boolean(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["name"],
  });
export type UpdateServiceRequest = z.infer<typeof updateServiceRequestSchema>;

export const reviewedServiceSchema = adminServiceSchema.safeExtend({
  version: z.number().int().positive(),
  sortOrder: z.number().int().nonnegative(),
  onlineBooking: z.boolean(),
});
export type ReviewedService = z.infer<typeof reviewedServiceSchema>;

export const reviewedServiceListSchema = z.object({
  generation: syncGenerationSchema,
  services: z.array(reviewedServiceSchema),
});

export const reviewedServiceUpdateSchema = z.strictObject({
  generation: syncGenerationSchema,
  version: z.number().int().positive(),
  service: updateServiceRequestSchema,
});

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
