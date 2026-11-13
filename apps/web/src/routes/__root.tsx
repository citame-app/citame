/// <reference types="vite/client" />

import frauncesLatin from "@fontsource-variable/fraunces/files/fraunces-latin-wght-normal.woff2?url";
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import type { QueryClient } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  HeadContent,
  Outlet,
  Scripts,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { type ReactNode, useEffect, useRef } from "react";
import { Footer, Header } from "~/components/layout";
import { OfflineBanner } from "~/components/ui/states";
import { ToastHost } from "~/components/ui/toast";
import { createTranslator, DEFAULT_LOCALE, type Locale } from "~/i18n";
import { I18nProvider, useI18n } from "~/i18n/react";
import { salonQuery } from "~/lib/queries";
import { pageMeta } from "~/lib/seo";
import { bootstrapQuery } from "~/server/request";
import appCss from "~/styles/app.css?url";

const FALLBACK_SALON = {
  name: "Sisters of Beauty",
  timezone: "America/Argentina/Buenos_Aires",
  slotGranularityMinutes: 15,
  minNoticeMinutes: 60,
  maxDaysAhead: 60,
};

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  // Session-dependent HTML must never be cached by a shared cache.
  headers: () => ({ "Cache-Control": "private, no-store" }),
  beforeLoad: async ({ context }) => {
    const [bootstrap, salon] = await Promise.all([
      context.queryClient.ensureQueryData(bootstrapQuery),
      context.queryClient.ensureQueryData(salonQuery).catch(() => FALLBACK_SALON),
    ]);
    return {
      locale: bootstrap.locale,
      theme: bootstrap.theme,
      session: bootstrap.session,
      salon,
    };
  },
  head: ({ match }) => {
    const locale = (match.context as { locale?: Locale }).locale ?? DEFAULT_LOCALE;
    const salon = (match.context as { salon?: typeof FALLBACK_SALON }).salon ?? FALLBACK_SALON;
    const t = createTranslator(locale);
    return {
      meta: [
        { charSet: "utf-8" },
        { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
        { name: "theme-color", content: "#fbf8f5", media: "(prefers-color-scheme: light)" },
        { name: "theme-color", content: "#171214", media: "(prefers-color-scheme: dark)" },
        ...pageMeta({
          title: salon.name,
          description: t("seo.home.description", { name: salon.name }),
          siteName: salon.name,
          locale,
        }),
      ],
      links: [
        {
          rel: "preload",
          href: interLatin,
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
        {
          rel: "preload",
          href: frauncesLatin,
          as: "font",
          type: "font/woff2",
          crossOrigin: "anonymous",
        },
        { rel: "stylesheet", href: appCss },
        { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
        { rel: "icon", href: "/favicon-32.png", type: "image/png", sizes: "32x32" },
        { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
        { rel: "manifest", href: "/site.webmanifest" },
      ],
    };
  },
  shellComponent: RootDocument,
  component: RootLayout,
});

function RootDocument({ children }: { children: ReactNode }) {
  const state = useRouterState({ select: (s) => s.matches[0]?.context }) as
    | { locale?: Locale; theme?: "light" | "dark" }
    | undefined;
  return (
    <html lang={state?.locale ?? DEFAULT_LOCALE} data-theme={state?.theme}>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootLayout() {
  const { locale, theme, session, salon } = Route.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();

  function changeLocale(next: Locale) {
    queryClient.setQueryData(bootstrapQuery.queryKey, (previous) =>
      previous ? { ...previous, locale: next } : previous,
    );
    void router.invalidate();
  }

  return (
    <I18nProvider locale={locale} timeZone={salon.timezone}>
      <ToastHost>
        <Chrome
          salonName={salon.name}
          timeZone={salon.timezone}
          session={session}
          theme={theme}
          locale={locale}
          onLocaleChange={changeLocale}
        />
      </ToastHost>
    </I18nProvider>
  );
}

function Chrome({
  salonName,
  timeZone,
  session,
  theme,
  locale,
  onLocaleChange,
}: {
  salonName: string;
  timeZone: string;
  session: Parameters<typeof Header>[0]["session"];
  theme: Parameters<typeof Header>[0]["theme"];
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  const mainRef = useRef<HTMLElement>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const firstRender = useRef(true);

  // Move focus to the page content after client-side navigations so keyboard and screen reader
  // users land on the new page instead of being left on the link they activated.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pathname is the trigger
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
  }, [pathname]);

  return (
    <div className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only z-[70] rounded-md bg-accent px-4 py-3 font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        {t("a11y.skip")}
      </a>
      <OfflineBanner />
      <Header
        salonName={salonName}
        session={session}
        theme={theme}
        locale={locale}
        onLocaleChange={onLocaleChange}
      />
      <main id="main" ref={mainRef} tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </main>
      <Footer salonName={salonName} timeZone={timeZone} />
    </div>
  );
}
