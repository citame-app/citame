import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./accounting";
export * from "./appointment-context";
export * from "./appointment-series";
export * from "./appointment-visits";
export * from "./appointments";
export * from "./auth";
export * from "./availability";
export * from "./booking-intent";
export * from "./booking-promotions";
export * from "./booking-protection";
export * from "./booksy-transfer";
export * from "./calendar";
export * from "./client-controls";
export * from "./client-details";
export * from "./client-merge";
export * from "./client-photos";
export * from "./client-transfer";
export * from "./clients";
export * from "./commerce";
export * from "./common";
export * from "./date-shifts";
export * from "./email-delivery";
export * from "./errors";
export * from "./gift-cards";
export * from "./intake";
export * from "./inventory";
export * from "./marketing";
export * from "./mcp";
export * from "./notifications";
export * from "./oauth";
export * from "./passes";
export * from "./permissions";
export * from "./portfolio";
export * from "./promotion-timing";
export * from "./reports";
export * from "./resources";
export * from "./reviews";
export * from "./rewards";
export * from "./salon";
export * from "./service-combinations";
export * from "./service-options";
export * from "./service-pricing";
export * from "./services";
export * from "./staff";
export * from "./staff-capacity";
export * from "./sync";
export * from "./waitlist";
