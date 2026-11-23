import { createHash } from "node:crypto";
import { z } from "zod";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const visibleBookingEnvelope = z.object({
  kind: z.literal("booksy-reviewed-visible-booking"),
  businessId: z.string(),
  parentHash: sha256,
  originals: z.array(z.object({ bytes: z.base64(), sha256 })).length(5),
});

export function decodeVisibleBookingObservations(envelope: z.infer<typeof visibleBookingEnvelope>) {
  return envelope.originals.map((original): unknown => {
    const bytes = Buffer.from(original.bytes, "base64");
    if (createHash("sha256").update(bytes).digest("hex") !== original.sha256)
      throw new Error("Screen observation has changed");
    return JSON.parse(bytes.toString("utf8"));
  });
}
