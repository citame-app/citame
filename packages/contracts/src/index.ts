import { z } from "zod";

export const healthResponseSchema = z.object({
  status: z.literal("ok"),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export * from "./accounting";
export * from "./appointments";
export * from "./auth";
export * from "./availability";
export * from "./calendar";
export * from "./clients";
export * from "./commerce";
export * from "./common";
export * from "./errors";
export * from "./inventory";
export * from "./mcp";
export * from "./notifications";
export * from "./oauth";
export * from "./reports";
export * from "./salon";
export * from "./services";
export * from "./staff";
export * from "./sync";
