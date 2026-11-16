import { z } from "zod";
/** Opaque bank reference only. Never accepts or stores a PAN, CVV or full bank response. */
export const mandateReferenceSchema = z
  .object({
    reference: z.string().regex(/^[A-Za-z0-9]{1,40}$/),
    transactionId: z
      .string()
      .regex(/^[A-Za-z0-9]{1,15}$/)
      .nullable(),
    expiry: z.string().regex(/^\d{2}(0[1-9]|1[0-2])$/),
    last4: z
      .string()
      .regex(/^\d{4}$/)
      .nullable(),
  })
  .strict();
export type MandateReference = z.infer<typeof mandateReferenceSchema>;
export interface MandateBinding {
  contractId: string;
  merchantCode: string;
  terminal: string;
  environment: "test" | "live";
  currency: "EUR";
}
