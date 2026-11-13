import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { AuthForm } from "~/features/auth/auth-form";
import { useAuth } from "~/features/auth/use-auth";
import { homeFor, resolveAccess } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } =>
    typeof raw.redirect === "string" ? { redirect: raw.redirect } : {},
  beforeLoad: ({ context, search }) => {
    if (resolveAccess("guest", context.session).type === "redirect-home" && context.session) {
      throw redirect({ to: search.redirect ?? homeFor(context.session.user.role) });
    }
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("auth.signIn.title"),
        description: t("auth.signIn.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: SignInPage,
});

function SignInPage() {
  const { t } = useI18n();
  const { redirect: redirectTo } = Route.useSearch();
  const auth = useAuth();
  return (
    <PageContainer width="max-w-md">
      <div className="py-10 sm:py-16">
        <PageHeading title={t("auth.signIn.title")} lead={t("auth.signIn.lead")} />
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <AuthForm
            mode="sign-in"
            onSubmit={(values) => auth.signIn(values, { redirectTo })}
            footer={
              <p className="text-center text-muted">
                {t("auth.signIn.switch")}{" "}
                <Link
                  to="/sign-up"
                  search={redirectTo ? { redirect: redirectTo } : {}}
                  className="font-medium text-accent-text underline underline-offset-4"
                >
                  {t("auth.signIn.switchLink")}
                </Link>
              </p>
            }
          />
        </div>
      </div>
    </PageContainer>
  );
}
