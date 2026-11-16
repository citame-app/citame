import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./accounting";
export * from "./appointment-series";
export * from "./appointments";
export * from "./auth";
export * from "./availability";
export * from "./booking-protection";
export * from "./calendar";
export * from "./client-controls";
export * from "./clients";
export * from "./commerce";
export * from "./common";
export * from "./errors";
export * from "./gift-cards";
export * from "./inventory";
export * from "./mcp";
export * from "./notifications";
export * from "./oauth";
export * from "./passes";
export * from "./permissions";
export * from "./reports";
export * from "./resources";
export * from "./rewards";
export * from "./salon";
export * from "./service-options";
export * from "./services";
export * from "./staff";
export * from "./sync";
export * from "./waitlist";
