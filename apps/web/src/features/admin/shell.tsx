import type { UserRole } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import { type ComponentType, type ReactNode, useEffect, useState } from "react";
import {
  CalendarIcon,
  ChartIcon,
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
  commerce: CreditCardIcon,
  clients: UserIcon,
  services: ScissorsIcon,
  staff: UsersIcon,
  reports: ChartIcon,
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
  active,
  children,
}: {
  role: UserRole;
  active: AdminSection;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const label = useNavLabel();
  const items = adminNavFor(role);
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
    <div className="mx-auto w-full max-w-[96rem] md:grid md:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="hidden md:block">
        <nav
          aria-label={t("admin.nav.label")}
          className="sticky top-16 flex max-h-[calc(100dvh-4rem)] flex-col gap-1 overflow-y-auto border-r border-line px-3 py-6"
        >
          {items.map((item) => {
            const Icon = ICONS[item.section];
            const current = item.section === active;
            return (
              <Link
                key={item.section}
                to={item.to}
                aria-current={current ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-3 rounded-md px-3 text-[0.95rem] font-medium transition-colors",
                  current
                    ? "bg-accent-soft text-accent-soft-fg"
                    : "text-muted hover:bg-sunken hover:text-fg",
                )}
              >
                <Icon width={20} height={20} />
                {label(item.section, role)}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div className="min-w-0 px-4 pt-6 pb-28 sm:px-6 md:pb-12 lg:px-8">{children}</div>

      <nav
        aria-label={`${t("admin.nav.label")} (mobile)`}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="mx-auto flex max-w-xl">
          {inline.map((item) => {
            const Icon = ICONS[item.section];
            const current = item.section === active;
            return (
              <li key={item.section} className="flex-1">
                <Link
                  to={item.to}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-medium",
                    current ? "text-accent-text" : "text-muted",
                  )}
                >
                  <Icon width={22} height={22} />
                  <span className="max-w-full truncate">{label(item.section, role)}</span>
                </Link>
              </li>
            );
          })}
          {overflow.length > 0 && (
            <li className="flex-1">
              <button
                type="button"
                onClick={() => setMoreOpen(true)}
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
                  onClick={() => setMoreOpen(false)}
                  aria-current={item.section === active ? "page" : undefined}
                  className="flex min-h-12 items-center gap-3 rounded-md px-3 font-medium hover:bg-sunken"
                >
                  <Icon width={22} height={22} />
                  {label(item.section, role)}
                </Link>
              </li>
            );
          })}
        </ul>
      </Sheet>
    </div>
  );
}
