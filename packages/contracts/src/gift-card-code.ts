import { z } from "zod";
export const giftCardCodeSchema = z
  .string()
  .max(80)
  .transform((value) => value.trim().toUpperCase().replace(/[ -]/g, ""))
  .pipe(z.string().regex(/^SOB[A-F0-9]{24}$/));
