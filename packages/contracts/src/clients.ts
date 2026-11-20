import { z } from "zod";
import { appointmentSchema } from "./appointments";
import { clientTagsSchema } from "./client-controls";
import { clientContactDetailsSchema } from "./client-details";
import {
  idSchema,
  instantSchema,
  LIMITS,
  pageInfoSchema,
  pageSchema,
  pageSizeSchema,
} from "./common";

export const CLIENT_PAGE_SIZE_DEFAULT = 20;
export const CLIENT_PAGE_SIZE_MAX = 100;

export const clientSortSchema = z.enum(["name", "createdAt", "lastVisitAt"]);
export type ClientSort = z.infer<typeof clientSortSchema>;

/** Query string of `GET /admin/clients`. Search matches name, phone and email. */
export const clientListQuerySchema = z.object({
  page: pageSchema.default(1),
  pageSize: pageSizeSchema(CLIENT_PAGE_SIZE_MAX).default(CLIENT_PAGE_SIZE_DEFAULT),
  search: z.string().trim().max(100).optional(),
  tag: clientTagsSchema.element.optional(),
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
  tags: z.array(z.string()).optional(),
  contactDetails: clientContactDetailsSchema.optional(),
  detailsVersion: z.number().int().positive().optional(),
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
  identity: z
    .object({
      rootId: idSchema,
      profiles: z
        .array(
          z.object({
            id: idSchema,
            name: z.string(),
            email: z.string().nullable(),
            phone: z.string().nullable(),
            notes: z.string().nullable(),
          }),
        )
        .max(20),
    })
    .optional(),
  /** Every appointment of the client, newest first. */
  appointments: z.array(appointmentSchema),
});
export type ClientDetailResponse = z.infer<typeof clientDetailResponseSchema>;

/** Identity (email, login link) is deliberately not editable here. */
export const updateClientRequestSchema = z
  .object({
    contactDetails: clientContactDetailsSchema.optional(),
    detailsVersion: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(LIMITS.name),
    phone: z.string().trim().min(3).max(LIMITS.phone).nullable(),
    notes: z.string().max(LIMITS.notes).nullable(),
  })
  .partial()
  .refine(
    (value) =>
      Object.entries(value).some(([key, v]) => key !== "detailsVersion" && v !== undefined),
    {
      message: "Provide at least one change",
      path: ["name"],
    },
  )
  .refine((value) => value.contactDetails === undefined || value.detailsVersion !== undefined, {
    message: "Contact details require their reviewed version",
    path: ["detailsVersion"],
  });
export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;

/** A standalone salon contact. An email here never creates or links a login account. */
export const createClientRequestSchema = z
  .object({
    id: idSchema,
    contactDetails: clientContactDetailsSchema.optional(),
    tags: clientTagsSchema.optional(),
    name: z.string().trim().min(1).max(LIMITS.name),
    phone: z.string().trim().min(3).max(LIMITS.phone).nullable().optional(),
    email: z.email().max(LIMITS.email).nullable().optional(),
    notes: z.string().max(LIMITS.notes).nullable().optional(),
  })
  .strict();
export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

export const clientGroupsSchema = z.object({
  groups: z.array(z.object({ name: z.string(), count: z.number().int().nonnegative() })),
});
