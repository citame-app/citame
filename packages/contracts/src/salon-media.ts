import { z } from "zod";
import { clientPhotoUploadSchema } from "./client-photos";
import { idSchema, instantSchema, syncGenerationSchema } from "./common";

export const PROFILE_MEDIA_GALLERY_LIMIT = 12;
export const profileMediaKindSchema = z.enum(["logo", "cover", "gallery"]);
export type ProfileMediaKind = z.infer<typeof profileMediaKindSchema>;
const description = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[^\p{Cc}\u2028\u2029]+$/u);
const dimension = z.number().int().min(1).max(1024);

export const publicProfileImageSchema = z.object({
  id: idSchema,
  kind: profileMediaKindSchema,
  version: idSchema,
  alt: description,
  width: dimension,
  height: dimension,
});
export type PublicProfileImage = z.infer<typeof publicProfileImageSchema>;
export const publicProfileImagesSchema = z
  .array(publicProfileImageSchema)
  .max(PROFILE_MEDIA_GALLERY_LIMIT + 2);
export const profileMediaSnapshotSchema = z.object({
  generation: syncGenerationSchema,
  revision: instantSchema,
  images: z
    .array(publicProfileImageSchema.extend({ published: z.boolean() }))
    .max(PROFILE_MEDIA_GALLERY_LIMIT + 2),
});
export type ProfileMediaSnapshot = z.infer<typeof profileMediaSnapshotSchema>;

export const profileMediaActionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("upload"),
    kind: profileMediaKindSchema,
    replaceId: idSchema.optional(),
    alt: description,
    imageBase64: clientPhotoUploadSchema.shape.imageBase64,
  }),
  z.strictObject({ mode: z.literal("publication"), id: idSchema, published: z.boolean() }),
  z.strictObject({ mode: z.literal("remove"), id: idSchema }),
]);
export type ProfileMediaAction = z.infer<typeof profileMediaActionSchema>;

export const profileMediaWriteSchema = z.strictObject({
  generation: syncGenerationSchema,
  expectedRevision: instantSchema,
  action: profileMediaActionSchema,
});
export type ProfileMediaWrite = z.infer<typeof profileMediaWriteSchema>;
