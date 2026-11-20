import { z } from "zod";

export const clientContactDetailsSchema = z
  .object({
    firstName: z.string().trim().max(100).optional(),
    lastName: z.string().trim().max(100).optional(),
    taxId: z.string().trim().max(50).optional(),
    address: z.string().trim().max(500).optional(),
    birthday: z
      .object({
        month: z.number().int().min(1).max(12),
        day: z.number().int().min(1).max(31),
        year: z.number().int().min(1900).max(2100).nullable().optional(),
      })
      .strict()
      .refine(
        (value) =>
          new Date(Date.UTC(value.year ?? 2000, value.month - 1, value.day)).getUTCMonth() ===
          value.month - 1,
        "Choose a valid birthday",
      )
      .nullable()
      .optional(),
    discountBasisPoints: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type ClientContactDetails = z.infer<typeof clientContactDetailsSchema>;
