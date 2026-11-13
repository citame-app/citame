import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./appointments";
export * from "./auth";
export * from "./availability";
export * from "./common";
export * from "./errors";
export * from "./services";
export * from "./staff";
