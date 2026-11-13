import { z } from "zod";
import { appointmentSchema } from "./appointments";
import { idSchema, instantSchema, pageInfoSchema, pageSchema, pageSizeSchema } from "./common";

export const CLIENT_PAGE_SIZE_DEFAULT = 20;
export const CLIENT_PAGE_SIZE_MAX = 100;

export const clientSortSchema = z.enum(["name", "createdAt", "lastVisitAt"]);
export type ClientSort = z.infer<typeof clientSortSchema>;

/** Query string of `GET /admin/clients`. Search matches name, phone and email. */
export const clientListQuerySchema = z.object({
  page: pageSchema.default(1),
  pageSize: pageSizeSchema(CLIENT_PAGE_SIZE_MAX).default(CLIENT_PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(100).optional(),
  sort: clientSortSchema.default("name"),
  order: z.enum(["asc", "desc"]).default("asc"),
});
export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

export const adminClientSchema = z.object({
  id: idSchema,
  name: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  /** Appointments that are not cancelled. */
  appointmentCount: z.number().int().min(0),
  /** Start of the latest non-cancelled appointment, if any. */
  lastVisitAt: instantSchema.nullable(),
});
export type AdminClient = z.infer<typeof adminClientSchema>;

export const listClientsResponseSchema = pageInfoSchema.extend({
  clients: z.array(adminClientSchema),
});
export type ListClientsResponse = z.infer<typeof listClientsResponseSchema>;

export const clientDetailResponseSchema = z.object({
  client: adminClientSchema,
  /** Every appointment of the client, newest first. */
  appointments: z.array(appointmentSchema),
});
export type ClientDetailResponse = z.infer<typeof clientDetailResponseSchema>;

/** Identity (email, login link) is deliberately not editable here. */
export const updateClientRequestSchema = z
  .object({
    name: z.string().trim().min(1),
    phone: z.string().trim().min(3).nullable(),
    notes: z.string().nullable(),
  })
  .partial()
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: "Provide at least one change",
    path: ["name"],
  });
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;
