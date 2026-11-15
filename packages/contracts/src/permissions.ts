import { z } from "zod";
import type { UserRole } from "./auth";
export const staffAccessPresetSchema = z.enum([
  "manager",
  "receptionist",
  "professional",
  "restricted",
]);
export type StaffAccessPreset = z.infer<typeof staffAccessPresetSchema>;
const NONE = {
  allCalendars: false,
  editCalendar: false,
  editSchedules: false,
  editCatalog: false,
  readInventory: false,
  writeInventory: false,
  readCosts: false,
  commerce: false,
  allSales: false,
  manageCash: false,
  refunds: false,
  financialReports: false,
  manageCommissions: false,
  clients: false,
  editClients: false,
  deleteClients: false,
  manageAccounts: false,
  manageSettings: false,
  operationalReports: false,
};
export type StaffPermissions = { [K in keyof typeof NONE]: boolean };
/** Shared presentation policy; the API recomputes this from the persisted principal. */
export function permissionsFor(
  role: UserRole,
  preset: StaffAccessPreset | null = "professional",
): StaffPermissions {
  const all = Object.fromEntries(Object.keys(NONE).map((key) => [key, true])) as StaffPermissions;
  if (role === "owner") return all;
  if (role === "client") return { ...NONE };
  switch (preset ?? "professional") {
    case "manager":
      return { ...all, manageAccounts: false, manageSettings: false };
    case "receptionist":
      return {
        ...NONE,
        allCalendars: true,
        editCalendar: true,
        readInventory: true,
        commerce: true,
        allSales: true,
        manageCash: true,
        clients: true,
        editClients: true,
        operationalReports: true,
      };
    case "professional":
      return {
        ...NONE,
        editCalendar: true,
        readInventory: true,
        commerce: true,
        clients: true,
        editClients: true,
        operationalReports: true,
      };
    case "restricted":
      return { ...NONE };
  }
}
export const staffAccessInputSchema = z
  .object({ preset: staffAccessPresetSchema, version: z.number().int().positive() })
  .strict();
export const staffAccessSchema = z.object({
  staffId: z.uuid(),
  preset: staffAccessPresetSchema,
  version: z.number().int().positive(),
  accountRole: z.enum(["owner", "staff", "client"]).nullable(),
});

export const staffPermissionsSchema = z.object(
  Object.fromEntries(Object.keys(NONE).map((key) => [key, z.boolean()])) as {
    [K in keyof StaffPermissions]: z.ZodBoolean;
  },
);
