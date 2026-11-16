import { createFileRoute, redirect } from "@tanstack/react-router";
import { AuthFrame } from "~/components/auth-frame";
import { PageHeading } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { ResendVerificationForm } from "~/features/auth/recovery-forms";
import { verificationCallback } from "~/features/auth/use-auth";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { homeFor, safeRedirect } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

interface VerifySearch {
  next?: string;
  error?: string;
}

/**
 * Where Better Auth sends the browser after the emailed confirmation link. On success it has
 * already signed the person in, so we simply continue to where they were going. On failure it
 * appends `?error=`, and the visitor can ask for a fresh link.
 */
export const Route = createFileRoute("/verify-email")({
  validateSearch: (raw: Record<string, unknown>): VerifySearch => ({
    ...(typeof raw.next === "string" ? { next: raw.next } : {}),
    ...(typeof raw.error === "string" ? { error: raw.error } : {}),
  }),
  beforeLoad: ({ context, search }) => {
    if (!search.error && context.session) {
      throw redirect({ to: safeRedirect(search.next, homeFor(context.session.user.role)) });
    }
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("auth.verify.meta.title"),
        description: t("auth.verify.doneBody"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: VerifyEmailPage,
});

function VerifyEmailPage() {
  const { t } = useI18n();
  const { error, next } = Route.useSearch();
  return (
    <AuthFrame>
      <div className="py-10 sm:py-16">
        {error ? (
          <>
            <PageHeading
              title={t("auth.verify.invalidTitle")}
              lead={t("auth.verify.invalidBody")}
            />
            <div className="rounded-xl border border-line bg-surface p-6 shadow-sm">
              <ResendVerificationForm
                onSubmit={async (email) => {
                  await api().auth.resendVerification(email, verificationCallback(next));
                }}
              />
            </div>
          </>
        ) : (
          <>
            <PageHeading title={t("auth.verify.doneTitle")} lead={t("auth.verify.doneBody")} />
            <a href="/sign-in" className={buttonClasses({ variant: "primary", fullWidth: true })}>
              {t("auth.verify.doneAction")}
            </a>
          </>
        )}
      </div>
    </AuthFrame>
  );
}
