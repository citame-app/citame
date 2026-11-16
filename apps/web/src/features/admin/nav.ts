import { permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";

export type AdminSection =
  | "today"
  | "calendar"
  | "waitlist"
  | "commerce"
  | "clients"
  | "services"
  | "staff"
  | "reports"
  | "reputation"
  | "settings";

interface SectionConfig {
  section: AdminSection;
  to: string;
  roles: readonly UserRole[];
}

const BOTH = ["owner", "staff"] as const;

/** Navigation order. The API enforces the same matrix (ADR 0004); this decides what to show. */
const SECTIONS: readonly SectionConfig[] = [
  { section: "today", to: "/admin", roles: BOTH },
  { section: "calendar", to: "/admin/calendar", roles: BOTH },
  { section: "waitlist", to: "/admin/waitlist", roles: BOTH },
  { section: "commerce", to: "/admin/commerce", roles: BOTH },
  { section: "clients", to: "/admin/clients", roles: BOTH },
  { section: "services", to: "/admin/services", roles: ["owner"] },
  { section: "staff", to: "/admin/staff", roles: BOTH },
  { section: "reports", to: "/admin/reports", roles: BOTH },
  { section: "reputation", to: "/admin/reputation", roles: BOTH },
  { section: "settings", to: "/admin/settings", roles: ["owner"] },
];

export function sectionOfPath(pathname: string): AdminSection {
  const segment = pathname.replace(/^\/admin\/?/, "").split("/")[0] ?? "";
  return SECTIONS.find((s) => s.to === `/admin/${segment}`)?.section ?? "today";
}

export function adminNavFor(
  role: UserRole,
  preset?: StaffAccessPreset | null,
): { section: AdminSection; to: string }[] {
  const permissions = permissionsFor(role, preset);
  const allowed = (s: SectionConfig) => {
    if (role === "client") return false;
    switch (s.section) {
      case "waitlist":
        return permissions.clients && permissions.editCalendar;
      case "services":
      case "reputation":
        return permissions.editCatalog;
      case "settings":
        return permissions.manageSettings;
      case "commerce":
        return permissions.commerce;
      case "clients":
        return permissions.clients;
      case "reports":
        return permissions.operationalReports;
      default:
        return s.roles.includes(role);
    }
  };
  return SECTIONS.filter(allowed).map(({ section, to }) => ({
    section,
    to,
  }));
}

export type AdminGuardDecision =
  | { type: "allow" }
  | { type: "redirect"; to: "/admin" | "/account"; notice: "forbidden" };

export function adminGuard(
  pathname: string,
  role: UserRole,
  preset?: StaffAccessPreset | null,
): AdminGuardDecision {
  if (role === "client") return { type: "redirect", to: "/account", notice: "forbidden" };
  const config = SECTIONS.find((s) => s.section === sectionOfPath(pathname));
  if (adminNavFor(role, preset).some((item) => item.section === config?.section))
    return { type: "allow" };
  return { type: "redirect", to: "/admin", notice: "forbidden" };
}
