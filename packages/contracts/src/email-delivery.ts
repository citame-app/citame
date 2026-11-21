import { z } from "zod";
import { idSchema } from "./common";

const name = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}<>]+$/u);
const sender = {
  fromEmail: z.email().max(254),
  fromName: name,
};
const smtp = z.strictObject({
  provider: z.literal("smtp"),
  ...sender,
  host: z
    .hostname()
    .max(253)
    .transform((host) => host.toLowerCase()),
  port: z.number().int().min(1).max(65535),
  encryption: z.enum(["tls", "starttls"]),
  username: z.string().trim().min(1).max(254),
});
export const emailDeliveryProviderSchema = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("inherit") }),
  z.strictObject({ provider: z.literal("disabled") }),
  smtp,
  z.strictObject({ provider: z.literal("gmail"), ...sender }),
  z.strictObject({ provider: z.literal("resend"), ...sender }),
]);
export type EmailDeliveryProvider = z.infer<typeof emailDeliveryProviderSchema>;

export const emailDeliveryInputSchema = z.strictObject({
  revision: idSchema.nullable(),
  settings: emailDeliveryProviderSchema,
  secret: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[^\p{Cc}]+$/u)
    .optional(),
});
export type EmailDeliveryInput = z.infer<typeof emailDeliveryInputSchema>;

export const emailDeliverySettingsSchema = z.strictObject({
  revision: idSchema.nullable(),
  settings: emailDeliveryProviderSchema,
  serverEmailEnabled: z.boolean(),
  hasSecret: z.boolean(),
});
export type EmailDeliverySettings = z.infer<typeof emailDeliverySettingsSchema>;

export const emailDeliveryTestInputSchema = z.object({ revision: idSchema.nullable() });
export const emailDeliveryTestReceiptSchema = z.object({ ok: z.literal(true) });
