import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { Button } from "~/components/ui/button";
import { LogOutIcon } from "~/components/ui/icons";
import { useAuth } from "~/features/auth/use-auth";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { resolveAccess } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/account")({
  // Any signed-in role may open the account area; anonymous visitors sign in and come back.
  beforeLoad: ({ context, location }) => {
    if (resolveAccess("account", context.session).type === "signin") {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("account.title"),
        description: t("account.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: AccountLayout,
});

const tabClass =
  "inline-flex min-h-11 items-center rounded-md px-4 text-[0.95rem] font-medium text-muted transition-colors hover:text-fg [&.active]:bg-accent-soft [&.active]:text-accent-soft-fg";

function AccountLayout() {
  const { t } = useI18n();
  const auth = useAuth();
  const { session } = Route.useRouteContext();
  return (
    <PageContainer width="max-w-3xl">
      <div className="py-8 sm:py-12">
        <PageHeading
          title={t("account.title")}
          lead={session ? t("common.greeting", { name: session.user.name }) : undefined}
        />
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
          <nav aria-label={t("account.nav.label")} className="-ml-4 flex gap-1">
            <Link to="/account" activeOptions={{ exact: true }} className={tabClass}>
              {t("account.nav.appointments")}
            </Link>
            <Link to="/account/profile" className={tabClass}>
              {t("account.nav.profile")}
            </Link>
            {session?.clientId && (
              <Link to="/account/notifications" className={tabClass}>
                {t("account.nav.notifications")}
              </Link>
            )}
          </nav>
          <Button variant="ghost" onClick={() => void auth.signOut()}>
            <LogOutIcon />
            {t("account.signOut")}
          </Button>
        </div>
        <Outlet />
      </div>
    </PageContainer>
  );
}
