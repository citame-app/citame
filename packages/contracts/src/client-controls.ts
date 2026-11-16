import { z } from "zod";
import { idSchema } from "./common";

const tag = z
  .string()
  .transform((value) => value.normalize("NFKC").trim().toLowerCase())
  .pipe(
    z
      .string()
      .min(1)
      .max(40)
      .regex(/^[^,;\p{Cc}]+$/u),
  );
export const clientTagsSchema = z
  .array(tag)
  .max(20)
  .refine((tags) => new Set(tags).size === tags.length, "Tags must be unique");
export const bookingAccessSchema = z.enum(["normal", "trusted", "blocked"]);
export const clientControlsInputSchema = z
  .object({
    version: z.number().int().positive(),
    tags: clientTagsSchema.optional(),
    bookingAccess: bookingAccessSchema.optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.tags === undefined && value.bookingAccess === undefined)
      ctx.addIssue({ code: "custom", message: "Provide a profile change" });
    if (value.bookingAccess !== undefined && !value.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A booking-access change requires a reason",
      });
    if (value.reason !== undefined && value.bookingAccess === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A reason must accompany an access change",
      });
  });
export const clientControlsSchema = z.object({
  clientId: idSchema,
  tags: clientTagsSchema,
  bookingAccess: bookingAccessSchema,
  reason: z.string().nullable(),
  version: z.number().int().positive(),
  canManageBookingAccess: z.boolean(),
});
export type ClientControls = z.infer<typeof clientControlsSchema>;
export type ClientControlsInput = z.infer<typeof clientControlsInputSchema>;
