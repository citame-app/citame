import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { AuthFrame } from "~/components/auth-frame";
import { PageHeading } from "~/components/pages";
import { AuthForm } from "~/features/auth/auth-form";
import { useAuth } from "~/features/auth/use-auth";
import { parseOAuthRequest } from "~/features/oauth/logic";
import { useRawSearch } from "~/features/oauth/use-raw-search";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { homeFor, resolveAccess } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/sign-in")({
  validateSearch: (raw: Record<string, unknown>): { redirect?: string } =>
    typeof raw.redirect === "string" ? { redirect: raw.redirect } : {},
  beforeLoad: ({ context, search, location }) => {
    // A signed-in visitor has nothing to do here, unless an app is waiting for them to sign
    // in: the authorization server only sends signed-in users straight to consent, so this
    // happens with an explicit prompt=login and the form below simply continues the flow.
    if (parseOAuthRequest(location.searchStr)) return;
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
  const searchStr = useRawSearch();
  const oauth = parseOAuthRequest(searchStr);
  return (
    <AuthFrame>
      <div className="py-10 sm:py-16">
        <PageHeading
          title={t("auth.signIn.title")}
          lead={oauth ? t("oauth.signIn.lead") : t("auth.signIn.lead")}
        />
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <AuthForm
            mode="sign-in"
            onSubmit={(values) => auth.signIn(values, { redirectTo, oauthQuery: oauth?.query })}
            footer={
              <p className="text-center text-muted">
                {t("auth.signIn.switch")}{" "}
                {oauth ? (
                  <a
                    href={`/sign-up?${oauth.query}`}
                    className="font-medium text-accent-text underline underline-offset-4"
                  >
                    {t("auth.signIn.switchLink")}
                  </a>
                ) : (
                  <Link
                    to="/sign-up"
                    search={redirectTo ? { redirect: redirectTo } : {}}
                    className="font-medium text-accent-text underline underline-offset-4"
                  >
                    {t("auth.signIn.switchLink")}
                  </Link>
                )}
              </p>
            }
          />
        </div>
      </div>
    </AuthFrame>
  );
}
