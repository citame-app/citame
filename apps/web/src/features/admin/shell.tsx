import { permissionsFor, type StaffAccessPreset, type UserRole } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import {
  CalendarIcon,
  ChartIcon,
  ClockIcon,
  CreditCardIcon,
  HomeIcon,
  MenuIcon,
  ScissorsIcon,
  SettingsIcon,
  UserIcon,
  UsersIcon,
} from "~/components/ui/icons";
import { Sheet } from "~/components/ui/sheet";
import type { TranslationKey } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { type AdminSection, adminNavFor } from "./nav";

const ICONS: Record<AdminSection, ComponentType<{ width?: number; height?: number }>> = {
  today: HomeIcon,
  calendar: CalendarIcon,
  waitlist: ClockIcon,
  commerce: CreditCardIcon,
  clients: UserIcon,
  services: ScissorsIcon,
  staff: UsersIcon,
  reports: ChartIcon,
  reputation: ChartIcon,
  settings: SettingsIcon,
};

/** Phones fit this many sections in the bottom bar before the rest move behind "More". */
const BOTTOM_BAR_MAX = 5;
/** What the front desk reaches for most; the rest of the owner sections live under "More". */
const BOTTOM_BAR_PRIORITY: readonly AdminSection[] = ["today", "calendar", "commerce", "clients"];

function useNavLabel() {
  const { t } = useI18n();
  return (section: AdminSection, role: UserRole): string => {
    const key: TranslationKey =
      section === "staff" && role === "staff"
        ? "admin.nav.staffOwn"
        : (`admin.nav.${section}` as TranslationKey);
    return t(key);
  };
}

export function AdminShell({
  role,
  accessPreset,
  active,
  children,
}: {
  role: UserRole;
  accessPreset?: StaffAccessPreset | null;
  active: AdminSection;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const label = useNavLabel();
  const items = adminNavFor(role, accessPreset);
  const fits = items.length <= BOTTOM_BAR_MAX;
  const inline = fits ? items : items.filter((i) => BOTTOM_BAR_PRIORITY.includes(i.section));
  const overflow = fits ? [] : items.filter((i) => !BOTTOM_BAR_PRIORITY.includes(i.section));
  const [moreOpen, setMoreOpen] = useState(false);

  // The fixed bottom bar (56px, min-h-14) must not be covered by toasts: tell the toast viewport.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--bottom-nav", "3.5rem");
    return () => {
      root.style.removeProperty("--bottom-nav");
    };
  }, []);

  return (
    <div
      className="admin-shell mx-auto w-full max-w-[100rem] md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]"
      data-section={active}
    >
      <aside className="admin-sidebar hidden md:block">
        <nav
          aria-label={t("admin.nav.label")}
          className="sticky top-16 flex max-h-[calc(100dvh-4rem)] min-h-[calc(100dvh-4rem)] flex-col gap-1 overflow-y-auto border-r border-line px-4 py-7"
        >
          <p className="sidebar-label mb-4 px-3 text-xs font-semibold uppercase tracking-widest text-muted">
            {t("admin.nav.label")}
          </p>
          {items.map((item) => {
            const Icon = ICONS[item.section];
            const current = item.section === active;
            return (
              <Link
                key={item.section}
                to={item.to}
                activeOptions={{ exact: true }}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 text-[0.95rem] font-medium transition-colors",
                  current ? "bg-accent text-accent-fg" : "text-muted hover:bg-sunken hover:text-fg",
                )}
              >
                <Icon width={20} height={20} />
                {label(
                  item.section,
                  permissionsFor(role, accessPreset).editSchedules ? "owner" : role,
                )}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="admin-workspace min-w-0 px-4 pt-7 pb-28 sm:px-6 md:pb-12 lg:px-10">
        {children}
      </div>

      <nav
        aria-label={`${t("admin.nav.label")} (mobile)`}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="mx-auto flex max-w-xl">
          {inline.map((item) => {
            const Icon = ICONS[item.section];
            const current = item.section === active;
            return (
              <li key={item.section} className="flex-1">
                <Link
                  to={item.to}
                  activeOptions={{ exact: true }}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium",
                    current ? "text-accent-text" : "text-muted",
                  )}
                >
                  <Icon width={22} height={22} />
                  <span className="max-w-full truncate">
                    {label(
                      item.section,
                      permissionsFor(role, accessPreset).editSchedules ? "owner" : role,
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
          {overflow.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
                aria-current={overflow.some((item) => item.section === active) ? "page" : undefined}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                className={cn(
                  "flex min-h-14 w-full flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium",
                  overflow.some((o) => o.section === active) ? "text-accent-text" : "text-muted",
                )}
              >
                <MenuIcon width={22} height={22} />
                {t("admin.nav.more")}
              </button>
            </li>
          )}
        </ul>
      </nav>

      <Sheet open={moreOpen} onOpenChange={setMoreOpen} title={t("admin.nav.more")}>
        <ul className="space-y-1">
          {overflow.map((item) => {
            const Icon = ICONS[item.section];
            return (
              <li key={item.section}>
                <Link
                  to={item.to}
                  activeOptions={{ exact: true }}
                  onClick={() => setMoreOpen(false)}
                  aria-current={item.section === active ? "page" : undefined}
                  className="flex min-h-12 items-center gap-3 rounded-md px-3 font-medium hover:bg-sunken"
                >
                  <Icon width={22} height={22} />
                  {label(
                    item.section,
                    permissionsFor(role, accessPreset).editSchedules ? "owner" : role,
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </div>
  );
}
