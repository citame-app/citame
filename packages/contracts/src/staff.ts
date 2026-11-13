import { z } from "zod";
import { idSchema } from "./common";

export const staffSchema = z.object({
  id: idSchema,
  displayName: z.string().min(1),
  serviceIds: z.array(idSchema),
});

export type Staff = z.infer<typeof staffSchema>;

export const listStaffResponseSchema = z.object({ staff: z.array(staffSchema) });
export type ListStaffResponse = z.infer<typeof listStaffResponseSchema>;
