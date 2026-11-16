import { createFileRoute } from "@tanstack/react-router";
import { AuthFrame } from "~/components/auth-frame";
import { PageHeading } from "~/components/pages";
import { ForgotPasswordForm } from "~/features/auth/recovery-forms";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/forgot-password")({
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("auth.forgot.title"),
        description: t("auth.forgot.meta.description"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: ForgotPasswordPage,
});

function ForgotPasswordPage() {
  const { t } = useI18n();
  return (
    <AuthFrame>
      <div className="py-10 sm:py-16">
        <PageHeading title={t("auth.forgot.title")} lead={t("auth.forgot.lead")} />
        <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
          <ForgotPasswordForm
            onSubmit={async (email) => {
              await api().auth.requestPasswordReset(email);
            }}
          />
        </div>
      </div>
    </AuthFrame>
  );
}
