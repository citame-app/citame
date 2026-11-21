import { z } from "zod";
import { clientPhotoUploadSchema } from "./client-photos";
import { idSchema, instantSchema, syncGenerationSchema } from "./common";
export const PORTFOLIO_LIMIT = 200;
export const PORTFOLIO_PERMISSION_VERSION = "public-portfolio-v1";
const caption = z
  .string()
  .trim()
  .min(1)
  .max(300)
  .refine((value) => !value.includes("\u0000"), "Unsupported null byte");
const generation = syncGenerationSchema.optional();
const metadata = { caption, alt: caption, serviceId: idSchema.nullable().default(null) };
export const portfolioUploadSchema = z
  .object({
    idempotencyKey: idSchema,
    generation,
    ...metadata,
    imageBase64: clientPhotoUploadSchema.shape.imageBase64,
  })
  .strict();
export const portfolioEditSchema = z
  .object({ version: z.number().int().positive(), generation, ...metadata })
  .strict();
export const portfolioVersionSchema = z
  .object({ version: z.number().int().positive(), generation })
  .strict();
export const portfolioPublishSchema = portfolioVersionSchema
  .extend({ publicationConfirmed: z.literal(true) })
  .strict();
export const portfolioRemoveSchema = portfolioVersionSchema
  .extend({ confirmation: z.literal(true) })
  .strict();
export const portfolioQuerySchema = z
  .object({
    before: idSchema.optional(),
    serviceId: idSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
const fields = {
  id: idSchema,
  caption,
  alt: caption,
  serviceId: idSchema.nullable(),
  serviceName: z.string().nullable(),
  width: z.number().int().positive().max(1024),
  height: z.number().int().positive().max(1024),
};
export const portfolioPublicPhotoSchema = z.object({ ...fields, publishedAt: instantSchema });
export const portfolioAdminPhotoSchema = z.object({
  ...fields,
  bytes: z.number().int().positive().max(262144),
  status: z.enum(["draft", "published"]),
  version: z.number().int().positive(),
  publishedAt: instantSchema.nullable(),
  createdAt: instantSchema,
});
export const portfolioPublicSchema = z.object({
  photos: z.array(portfolioPublicPhotoSchema),
  nextBefore: idSchema.nullable(),
});
export const portfolioAdminSchema = z.object({
  photos: z.array(portfolioAdminPhotoSchema).max(PORTFOLIO_LIMIT),
  limit: z.literal(PORTFOLIO_LIMIT),
});
export const portfolioRemovedSchema = z.object({ id: idSchema, removed: z.literal(true) });
export type PortfolioUpload = z.infer<typeof portfolioUploadSchema>;
export type PortfolioEdit = z.infer<typeof portfolioEditSchema>;
export type PortfolioAdminPhoto = z.infer<typeof portfolioAdminPhotoSchema>;
export type PortfolioPublicPhoto = z.infer<typeof portfolioPublicPhotoSchema>;
