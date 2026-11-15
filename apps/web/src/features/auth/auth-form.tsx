import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { PasswordField, TextField } from "~/components/ui/field";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { CheckInbox } from "./check-inbox";
import { type FieldErrors, type SignInValues, type SignUpValues, validateAuth } from "./validate";

export interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  /**
   * Resolves on success; throws the API error otherwise so the form can explain it. Sign-up
   * resolves with `verifyEmail` when the address must be confirmed before the first sign-in.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: sign-in callbacks return Promise<void>.
  onSubmit: (values: SignInValues | SignUpValues) => Promise<void | { verifyEmail: string }>;
  /** Sends the confirmation link again (shown with the "check your inbox" notice). */
  onResendVerification?: (email: string) => Promise<void>;
  footer?: ReactNode;
}

export function AuthForm({ mode, onSubmit, onResendVerification, footer }: AuthFormProps) {
  const { t } = useI18n();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [verifyEmail, setVerifyEmail] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function focusFirstInvalid() {
    // Wait for the error state to render so aria-invalid is on the DOM.
    queueMicrotask(() => {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const result =
      mode === "sign-in"
        ? validateAuth("sign-in", { email: values.email, password: values.password }, t)
        : validateAuth("sign-up", values, t);
    if (!result.ok) {
      setErrors(result.errors);
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setPending(true);
    try {
      const outcome = await onSubmit(result.data);
      if (outcome && "verifyEmail" in outcome) setVerifyEmail(outcome.verifyEmail);
    } catch (error) {
      if (error instanceof ApiError && error.code === "email_taken") {
        setErrors({ email: t("auth.error.emailTaken") });
        focusFirstInvalid();
      } else if (error instanceof ApiError && error.code === "weak_password") {
        setErrors({ password: t("validation.password.min") });
        focusFirstInvalid();
      } else if (error instanceof ApiError && error.code === "invalid_email") {
        setErrors({ email: t("validation.email") });
        focusFirstInvalid();
      } else {
        if (error instanceof ApiError && error.code === "rate_limited") {
          setCooldown(error.retryAfterSeconds ?? 30);
        }
        setFormError(error);
      }
    } finally {
      setPending(false);
    }
  }

  if (verifyEmail) {
    return (
      <CheckInbox
        email={verifyEmail}
        onResend={() =>
          onResendVerification ? onResendVerification(verifyEmail) : Promise.resolve()
        }
      />
    );
  }

  const submitLabel = mode === "sign-in" ? t("auth.signIn.submit") : t("auth.signUp.submit");

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      {formError !== null && <FormError error={formError} cooldown={cooldown} />}
      {mode === "sign-up" && (
        <TextField
          label={t("auth.field.name")}
          name="name"
          autoComplete="name"
          value={values.name}
          onChange={(e) => {
            setValues((v) => ({ ...v, name: e.target.value }));
            setErrors(({ name: _cleared, ...rest }) => rest);
          }}
          error={errors.name}
          required
        />
      )}
      <TextField
        label={t("auth.field.email")}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        value={values.email}
        onChange={(e) => {
          setValues((v) => ({ ...v, email: e.target.value }));
          setErrors(({ email: _cleared, ...rest }) => rest);
        }}
        error={errors.email}
        required
      />
      <PasswordField
        label={t("auth.field.password")}
        name="password"
        autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
        value={values.password}
        onChange={(e) => {
          setValues((v) => ({ ...v, password: e.target.value }));
          setErrors(({ password: _cleared, ...rest }) => rest);
        }}
        error={errors.password}
        hint={mode === "sign-up" ? t("auth.field.passwordHint") : undefined}
        required
      />
      {mode === "sign-in" && (
        <p className="-mt-4 text-sm">
          <a
            href="/forgot-password"
            className="inline-flex min-h-11 items-center font-medium text-accent-text underline underline-offset-4"
          >
            {t("auth.forgot.link")}
          </a>
        </p>
      )}
      <Button type="submit" size="lg" fullWidth loading={pending} disabled={cooldown > 0}>
        {submitLabel}
      </Button>
      {footer}
    </form>
  );
}

function FormError({ error, cooldown }: { error: unknown; cooldown: number }) {
  const { t } = useI18n();
  if (error instanceof ApiError && error.code === "invalid_credentials") {
    return (
      <p
        role="alert"
        className="rounded-md bg-danger-soft px-4 py-3 text-[0.95rem] font-medium text-danger-fg"
      >
        {t("auth.error.invalid")}
      </p>
    );
  }
  if (error instanceof ApiError && error.code === "email_not_verified") {
    return (
      <p
        role="alert"
        className="rounded-md bg-warning-soft px-4 py-3 text-[0.95rem] font-medium text-warning-fg"
      >
        {t("auth.error.unverified")}
      </p>
    );
  }
  if (error instanceof ApiError && error.code === "rate_limited") {
    return (
      <div role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-danger-fg">
        <p className="font-semibold">{t("error.rateLimited.title")}</p>
        <p className="text-[0.95rem]">
          {t("error.rateLimited.body", {
            count: cooldown > 0 ? cooldown : (error.retryAfterSeconds ?? 30),
          })}
        </p>
      </div>
    );
  }
  if (error instanceof NetworkError) return <ErrorState error={error} />;
  return <ErrorState error={error} />;
}
