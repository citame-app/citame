import { createFileRoute } from "@tanstack/react-router";
import { AuthFrame } from "~/components/auth-frame";
import { PageHeading } from "~/components/pages";
import { InvalidResetLink, ResetPasswordForm } from "~/features/auth/recovery-forms";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { pageMeta } from "~/lib/seo";

interface ResetSearch {
  token?: string;
  error?: string;
  invited?: boolean;
}

/**
 * Landing page of the emailed reset (and staff invitation) link. Better Auth validates the
 * token first and redirects here with `?token=` or `?error=INVALID_TOKEN`.
 */
export const Route = createFileRoute("/reset-password")({
  validateSearch: (raw: Record<string, unknown>): ResetSearch => ({
    ...(typeof raw.token === "string" ? { token: raw.token } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
    ...(raw.invited === "1" || raw.invited === 1 || raw.invited === true ? { invited: true } : {}),
  }),
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("auth.reset.title"),
        description: t("auth.reset.meta.description"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const { t } = useI18n();
  const { token, error, invited } = Route.useSearch();
  const usable = token && !error;
  return (
    <AuthFrame>
      <div className="py-10 sm:py-16">
        <PageHeading
          title={invited ? t("auth.reset.invite.title") : t("auth.reset.title")}
          lead={usable ? (invited ? t("auth.reset.invite.lead") : t("auth.reset.lead")) : undefined}
        />
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          {usable ? (
            <ResetPasswordForm
              onSubmit={async (password) => {
                await api().auth.resetPassword(token, password);
              }}
            />
          ) : (
            <InvalidResetLink />
          )}
        </div>
      </div>
    </AuthFrame>
  );
}
