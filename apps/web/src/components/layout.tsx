import type { MeResponse } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import type { Locale } from "~/i18n";
import { useI18n } from "~/i18n/react";
import type { Theme } from "~/lib/theme";
import { LocaleSwitch, ThemeToggle } from "./shell";
import { buttonClasses } from "./ui/button";
import { UserIcon } from "./ui/icons";

export function SkipLink() {
  const { t } = useI18n();
  return (
    <a
      href="#main"
      className="sr-only z-[70] rounded-md bg-accent px-4 py-3 font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      {t("a11y.skip")}
    </a>
  );
}

export function Header({
  salonName,
  session,
  theme,
  locale,
  onLocaleChange,
  onThemeChange,
  showDiscovery = false,
}: {
  showDiscovery?: boolean;
  salonName: string;
  session: MeResponse | null;
  theme: Theme | undefined;
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: Theme) => void;
}) {
  const { t } = useI18n();
  const staff = session && session.user.role !== "client";
  return (
    <header
      data-discovery={showDiscovery || undefined}
      className="nav site-header sticky top-0 z-30 border-b border-line bg-surface"
    >
      <SkipLink />
      <div className="wrap header-bar mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-2 px-4 sm:px-6">
        <Link
          to="/"
          className="brand-wordmark flex min-h-11 items-center font-display text-lg tracking-tight sm:text-xl"
          aria-label={salonName}
        >
          <span aria-hidden="true" className="brand-mark mr-3">
            <i />
            <i />
            <i />
          </span>
          {salonName}
        </Link>

        {showDiscovery && (
          <nav
            aria-label={t("home.ctaSecondary")}
            className="header-discovery flex items-center gap-6"
          >
            <a href="/#services">{t("home.services.title")}</a>
            <Link to="/reviews">{t("reviews.title")}</Link>
            <Link to="/portfolio">{t("portfolio.title")}</Link>
          </nav>
        )}
        <nav aria-label={t("nav.main")} className="flex items-center gap-1 sm:gap-2">
          <LocaleSwitch locale={locale} onChange={onLocaleChange} />
          <ThemeToggle initial={theme} onChange={onThemeChange} />
          {session ? (
            <Link
              to={staff ? "/admin" : "/account"}
              className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sunken sm:px-3"
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
              className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-md px-2 text-sm font-medium hover:bg-sunken sm:px-3"
              aria-label={t("nav.signIn")}
            >
              <UserIcon />
              <span className="hidden sm:inline">{t("nav.signIn")}</span>
            </Link>
          )}
          <Link to="/book" className={`${buttonClasses({ variant: "primary" })} max-sm:hidden`}>
            {t("nav.book")}
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function Footer({ salonName, timeZone }: { salonName: string; timeZone: string }) {
  const { t, locale } = useI18n();
  return (
    <footer className="closing site-footer border-t border-line bg-surface">
      <div className="wrap editorial-wrap">
        <div className="footer-columns grid gap-6 py-10 sm:grid-cols-2">
          <div>
            <Link to="/" className="font-display text-2xl">
              {salonName}
            </Link>
            <p className="mt-3 max-w-xs text-sm text-muted">{t("footer.tagline")}</p>
            <p className="mt-3 text-sm text-muted">
              {t("footer.timezone", { timezone: timeZone.replaceAll("_", " ") })}
            </p>
          </div>
          <nav aria-label={t("home.services.title")} className="flex flex-col items-start text-sm">
            <Link to="/book">{t("nav.book")}</Link>
            <Link to="/portfolio">{t("portfolio.title")}</Link>
            <Link to="/reviews">{t("reviews.title")}</Link>
            <Link to="/account">{t("nav.account")}</Link>
          </nav>
        </div>
        <div className="border-t border-line py-5 text-xs text-muted">
          {locale === "en"
            ? "Editorial illustrations generated with AI. Client work appears in the portfolio."
            : "Ilustraciones editoriales generadas con IA. Los trabajos del salón aparecen en el portfolio."}
        </div>
      </div>
    </footer>
  );
}
