import type { MeResponse } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import type { Locale } from "~/i18n";
import { useI18n } from "~/i18n/react";
import type { Theme } from "~/lib/theme";
import { LocaleSwitch, ThemeToggle } from "./shell";
import { buttonClasses } from "./ui/button";
import { UserIcon } from "./ui/icons";

export function Header({
  salonName,
  session,
  theme,
  locale,
  onLocaleChange,
}: {
  salonName: string;
  session: MeResponse | null;
  theme: Theme | undefined;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  const staff = session && session.user.role !== "client";
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur supports-[backdrop-filter]:bg-canvas/80">
      <div className="mx-auto flex min-h-16 w-full max-w-6xl items-center justify-between gap-2 px-4 sm:px-6">
        <Link
          to="/"
          className="flex min-h-11 items-center font-display text-lg font-semibold tracking-tight sm:text-xl"
          aria-label={salonName}
        >
          <span aria-hidden="true" className="mr-2 inline-block size-2.5 rounded-full bg-accent" />
          {salonName}
        </Link>

        <nav aria-label={t("nav.main")} className="flex items-center gap-1 sm:gap-2">
          <LocaleSwitch locale={locale} onChange={onLocaleChange} />
          <ThemeToggle initial={theme} />
          {session ? (
            <Link
              to={staff ? "/admin" : "/account"}
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sunken sm:px-3"
              aria-label={staff ? t("nav.dashboard") : t("nav.account")}
            >
              <UserIcon />
              <span className="hidden sm:inline">
                {staff ? t("nav.dashboard") : t("nav.account")}
              </span>
            </Link>
          ) : (
            <Link
              to="/sign-in"
              className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sunken sm:px-3"
              aria-label={t("nav.signIn")}
            >
              <UserIcon />
              <span className="hidden sm:inline">{t("nav.signIn")}</span>
            </Link>
          )}
          <Link
            to="/book"
            className={`${buttonClasses({ variant: "primary" })} hidden sm:inline-flex`}
          >
            {t("nav.book")}
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function Footer({ salonName, timeZone }: { salonName: string; timeZone: string }) {
  const { t } = useI18n();
  return (
    <footer className="mt-20 border-t border-line bg-sunken">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          <span className="font-display text-base font-semibold text-fg">{salonName}</span>
          <span className="mx-2" aria-hidden="true">
            ·
          </span>
          {t("footer.tagline")}
        </p>
        <p>{t("footer.timezone", { timezone: timeZone.replaceAll("_", " ") })}</p>
      </div>
    </footer>
  );
}
