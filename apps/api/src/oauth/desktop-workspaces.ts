import {
  desktopWorkspaceSchema,
  permissionsFor,
  type DesktopWorkspace,
  type StaffPermissions,
} from "@sob/contracts";
import type { Principal } from "../auth/principal";

const destinations = {
  waitlist: ["/admin/waitlist", "clients"],
  clients: ["/admin/clients", "clients"],
  services: ["/admin/services", "editCatalog"],
  staff: ["/admin/staff", null],
  resources: ["/admin/staff?section=resources", "editCatalog"],
  sales: ["/admin/commerce", "commerce"],
  transactions: ["/admin/commerce?view=transactions", "commerce"],
  inventory: ["/admin/commerce?view=inventory", "readInventory"],
  benefits: ["/admin/commerce?view=rewards", "commerce"],
  reports: ["/admin/reports", "operationalReports"],
  commissions: ["/admin/staff?section=commissions", "commerce"],
  marketing: ["/admin/marketing", "editCatalog"],
  reputation: ["/admin/reputation", "editCatalog"],
  settings: ["/admin/settings", "manageSettings"],
  whatsapp: ["/admin/whatsapp", "manageSettings"],
} as const satisfies Record<DesktopWorkspace, readonly [string, keyof StaffPermissions | null]>;

export function desktopWorkspacePath(workspace: DesktopWorkspace, principal: Principal) {
  if (principal.role === "client") return null;
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  const [path, permission] = destinations[workspace];
  if (
    (permission && !permissions[permission]) ||
    (workspace === "inventory" && !permissions.commerce) ||
    (workspace === "waitlist" && !permissions.editCalendar)
  )
    return null;
  return path;
}

export function desktopWorkspaces(principal: Principal) {
  return desktopWorkspaceSchema.options.filter((workspace) =>
    desktopWorkspacePath(workspace, principal),
  );
}
