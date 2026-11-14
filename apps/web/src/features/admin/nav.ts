import type { UserRole } from "@sob/contracts";

export type AdminSection =
  | "today"
  | "calendar"
  | "clients"
  | "services"
  | "staff"
  | "reports"
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
  { section: "clients", to: "/admin/clients", roles: BOTH },
  { section: "services", to: "/admin/services", roles: ["owner"] },
  { section: "staff", to: "/admin/staff", roles: BOTH },
  { section: "reports", to: "/admin/reports", roles: BOTH },
  { section: "settings", to: "/admin/settings", roles: ["owner"] },
];

export function sectionOfPath(pathname: string): AdminSection {
  const segment = pathname.replace(/^\/admin\/?/, "").split("/")[0] ?? "";
  return SECTIONS.find((s) => s.to === `/admin/${segment}`)?.section ?? "today";
}

export function adminNavFor(role: UserRole): { section: AdminSection; to: string }[] {
  return SECTIONS.filter((s) => s.roles.includes(role)).map(({ section, to }) => ({
    section,
    to,
  }));
}

export type AdminGuardDecision =
  | { type: "allow" }
  | { type: "redirect"; to: "/admin" | "/account"; notice: "forbidden" };

export function adminGuard(pathname: string, role: UserRole): AdminGuardDecision {
  if (role === "client") return { type: "redirect", to: "/account", notice: "forbidden" };
  const config = SECTIONS.find((s) => s.section === sectionOfPath(pathname));
  if (config?.roles.includes(role)) return { type: "allow" };
  return { type: "redirect", to: "/admin", notice: "forbidden" };
}
