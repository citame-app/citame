import { z } from "zod";
import { idSchema, instantSchema, localDateSchema } from "./common";

export const CLIENT_PHOTO_INPUT_MAX_BYTES = 524288;
export const CLIENT_PHOTO_STORED_MAX_BYTES = 262144;
export const CLIENT_PHOTO_PER_CLIENT_LIMIT = 20;
export const CLIENT_PHOTO_SALON_LIMIT = 2000;
export const CLIENT_PHOTO_PERMISSION_VERSION = "private-client-photo-v1";
const caption = z.string().trim().min(1).max(300);
export const rasterImageBase64Schema = z
  .string()
  .min(4)
  .max(4 * Math.ceil(CLIENT_PHOTO_INPUT_MAX_BYTES / 3))
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .refine(
    (value) =>
      value.length % 4 === 0 &&
      (value.length * 3) / 4 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <=
        CLIENT_PHOTO_INPUT_MAX_BYTES,
    "Photo exceeds the decoded byte limit",
  );
export const clientPhotoUploadSchema = z
  .object({
    idempotencyKey: idSchema,
    caption,
    capturedOn: localDateSchema.optional(),
    permissionConfirmed: z.literal(true),
    imageBase64: rasterImageBase64Schema,
  })
  .strict();
export const clientPhotoUpdateSchema = z
  .object({ version: z.number().int().positive(), caption, capturedOn: localDateSchema.nullable() })
  .strict();
export const clientPhotoDeleteQuerySchema = z
  .object({ version: z.coerce.number().int().positive() })
  .strict();
export const clientPhotoSchema = z.object({
  id: idSchema,
  clientId: idSchema,
  caption,
  capturedOn: localDateSchema.nullable(),
  width: z.number().int().positive().max(1024),
  height: z.number().int().positive().max(1024),
  bytes: z.number().int().positive().max(CLIENT_PHOTO_STORED_MAX_BYTES),
  version: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export const clientPhotosSchema = z.object({
  photos: z.array(clientPhotoSchema).max(CLIENT_PHOTO_PER_CLIENT_LIMIT),
  canEdit: z.boolean(),
  limit: z.literal(CLIENT_PHOTO_PER_CLIENT_LIMIT),
});
export type ClientPhoto = z.infer<typeof clientPhotoSchema>;
export type ClientPhotoUpload = z.infer<typeof clientPhotoUploadSchema>;
export type ClientPhotoUpdate = z.infer<typeof clientPhotoUpdateSchema>;
