import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { AuthForm } from "~/features/auth/auth-form";
import { useAuth } from "~/features/auth/use-auth";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { homeFor } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/sign-up")({
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } =>
    typeof raw.redirect === "string" ? { redirect: raw.redirect } : {},
  beforeLoad: ({ context, search }) => {
    if (context.session) {
      throw redirect({ to: search.redirect ?? homeFor(context.session.user.role) });
    }
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("auth.signUp.title"),
        description: t("auth.signUp.lead"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: SignUpPage,
});

function SignUpPage() {
  const { t } = useI18n();
  const { redirect: redirectTo } = Route.useSearch();
  const auth = useAuth();
  return (
    <PageContainer width="max-w-md">
      <div className="py-10 sm:py-16">
        <PageHeading title={t("auth.signUp.title")} lead={t("auth.signUp.lead")} />
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <AuthForm
            mode="sign-up"
            onSubmit={(values) =>
              auth.signUp({ ...values, name: "name" in values ? values.name : "" }, { redirectTo })
            }
            footer={
              <p className="text-center text-muted">
                {t("auth.signUp.switch")}{" "}
                <Link
                  to="/sign-in"
                  search={redirectTo ? { redirect: redirectTo } : {}}
                  className="font-medium text-accent-text underline underline-offset-4"
                >
                  {t("auth.signUp.switchLink")}
                </Link>
              </p>
            }
          />
        </div>
      </div>
    </PageContainer>
  );
}
