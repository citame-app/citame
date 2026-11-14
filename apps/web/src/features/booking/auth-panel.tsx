import { forwardRef, useState } from "react";
import { AuthForm } from "~/features/auth/auth-form";
import { useAuth } from "~/features/auth/use-auth";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";

/** Sign in / sign up inside the review step. The booking selection stays in the URL untouched. */
/** Back to this very step (selection lives in the URL) once the address is confirmed. */
const returnTo = () => `${window.location.pathname}${window.location.search}`;

export const InlineAuth = forwardRef<HTMLElement>(function InlineAuth(_, ref) {
  const { t } = useI18n();
  const auth = useAuth();
  const [mode, setMode] = useState<"sign-up" | "sign-in">("sign-up");

  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-labelledby="inline-auth-title"
      className="rounded-xl border border-line bg-surface p-5 shadow-sm outline-none sm:p-6"
    >
      <h2 id="inline-auth-title" className="text-heading">
        {t("booking.review.authTitle")}
      </h2>
      <p className="mt-1 text-muted">{t("booking.review.authLead")}</p>
      <div
        role="tablist"
        aria-label={t("booking.review.authTitle")}
        className="mt-5 flex gap-1 rounded-lg bg-sunken p-1"
      >
        {(["sign-up", "sign-in"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`auth-tab-${value}`}
            aria-selected={mode === value}
            aria-controls="auth-tabpanel"
            onClick={() => setMode(value)}
            className={cn(
              "min-h-11 flex-1 rounded-md px-3 text-sm font-medium transition-colors",
              mode === value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
            )}
          >
            {value === "sign-up" ? t("booking.review.tab.new") : t("booking.review.tab.existing")}
          </button>
        ))}
      </div>
      <div id="auth-tabpanel" role="tabpanel" aria-labelledby={`auth-tab-${mode}`} className="mt-5">
        <AuthForm
          key={mode}
          mode={mode}
          onResendVerification={(email) => auth.resendVerification(email, returnTo())}
          onSubmit={(values) =>
            mode === "sign-in"
              ? auth.signIn(values, { stay: true })
              : auth.signUp(
                  { ...values, name: "name" in values ? values.name : "" },
                  { stay: true, afterVerification: returnTo() },
                )
          }
        />
      </div>
    </section>
  );
});
