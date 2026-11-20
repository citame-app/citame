import { z } from "zod";
export const servicePriceTypeSchema = z.enum(["fixed", "variable", "hidden", "free", "from"]);
export type ServicePriceType = z.infer<typeof servicePriceTypeSchema>;
export const needsFinalPrice = (type?: ServicePriceType | null) =>
  type === "variable" || type === "from";
