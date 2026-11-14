import { passwordSchema } from "@sob/contracts";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button, buttonClasses } from "~/components/ui/button";
import { PasswordField, TextField } from "~/components/ui/field";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";

function useCooldown() {
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  return [cooldown, setCooldown] as const;
}

function RateLimited({ seconds }: { seconds: number }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="rounded-md bg-danger-soft px-4 py-3 text-danger-fg">
      <p className="font-semibold">{t("error.rateLimited.title")}</p>
      <p className="text-[0.95rem]">{t("error.rateLimited.body", { count: seconds })}</p>
    </div>
  );
}

/** Asks for a reset link. Whatever the server knows, the visitor always sees the same answer. */
export function ForgotPasswordForm({ onSubmit }: { onSubmit: (email: string) => Promise<void> }) {
  return <EmailRequestForm purpose="reset" onSubmit={onSubmit} />;
}

/** Asks for a fresh confirmation link after an expired or used one. Same neutral answer. */
export function ResendVerificationForm({
  onSubmit,
}: {
  onSubmit: (email: string) => Promise<void>;
}) {
  return <EmailRequestForm purpose="verify" onSubmit={onSubmit} />;
}

function EmailRequestForm({
  purpose,
  onSubmit,
}: {
  purpose: "reset" | "verify";
  onSubmit: (email: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<unknown>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useCooldown();

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = z.email().safeParse(email.trim());
    if (!parsed.success) {
      setError(t("validation.email"));
      queueMicrotask(() => formRef.current?.querySelector<HTMLElement>("input")?.focus());
      return;
    }
    setError(undefined);
    setPending(true);
    try {
      await onSubmit(parsed.data);
      setSentTo(parsed.data);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "rate_limited") {
        setCooldown(caught.retryAfterSeconds ?? 30);
      }
      setFormError(caught);
    } finally {
      setPending(false);
    }
  }

  if (sentTo) {
    return (
      <section aria-labelledby="forgot-sent-title" className="space-y-4">
        <h2 id="forgot-sent-title" className="text-heading">
          {t("auth.forgot.sentTitle")}
        </h2>
        <p role="status">
          {purpose === "reset"
            ? t("auth.forgot.sentBody", { email: sentTo })
            : t("auth.verify.body", { email: sentTo })}
        </p>
        <a href="/sign-in" className={buttonClasses({ variant: "secondary", fullWidth: true })}>
          {t("auth.forgot.back")}
        </a>
      </section>
    );
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      {formError !== null &&
        (formError instanceof ApiError && formError.code === "rate_limited" ? (
          <RateLimited seconds={cooldown > 0 ? cooldown : (formError.retryAfterSeconds ?? 30)} />
        ) : (
          <ErrorState error={formError} />
        ))}
      <TextField
        label={t("auth.field.email")}
        name="email"
        type="email"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={error}
        required
      />
      <Button type="submit" size="lg" fullWidth loading={pending} disabled={cooldown > 0}>
        {purpose === "reset" ? t("auth.forgot.submit") : t("auth.verify.invalidSubmit")}
      </Button>
      <p className="text-center">
        <a
          href="/sign-in"
          className="inline-flex min-h-11 items-center font-medium text-accent-text underline underline-offset-4"
        >
          {t("auth.forgot.back")}
        </a>
      </p>
    </form>
  );
}

/** Chooses the new password. Staff invitations use the same form; only the page copy differs. */
export function ResetPasswordForm({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
  const { t } = useI18n();
  const formRef = useRef<HTMLFormElement>(null);
  const [values, setValues] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState<{ password?: string; confirm?: string }>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);
  const [cooldown, setCooldown] = useCooldown();

  function focusFirstInvalid() {
    queueMicrotask(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    const parsed = passwordSchema.safeParse(values.password);
    if (!parsed.success) {
      setErrors({
        password:
          values.password.length > 128
            ? t("validation.password.max")
            : t("validation.password.min"),
      });
      focusFirstInvalid();
      return;
    }
    if (values.confirm !== values.password) {
      setErrors({ confirm: t("auth.reset.mismatch") });
      focusFirstInvalid();
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await onSubmit(parsed.data);
      setDone(true);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "rate_limited") {
        setCooldown(caught.retryAfterSeconds ?? 30);
      }
      setFormError(caught);
    } finally {
      setPending(false);
    }
  }

  if (done) {
    return (
      <section aria-labelledby="reset-done-title" className="space-y-4">
        <h2 id="reset-done-title" className="text-heading">
          {t("auth.reset.doneTitle")}
        </h2>
        <p role="status">{t("auth.reset.doneBody")}</p>
        <a href="/sign-in" className={buttonClasses({ variant: "primary", fullWidth: true })}>
          {t("auth.reset.doneAction")}
        </a>
      </section>
    );
  }
  if (formError instanceof ApiError && formError.code === "invalid_token") {
    return <InvalidResetLink />;
  }

  return (
    <form ref={formRef} onSubmit={submit} noValidate className="space-y-5">
      {formError !== null &&
        (formError instanceof ApiError && formError.code === "rate_limited" ? (
          <RateLimited seconds={cooldown > 0 ? cooldown : (formError.retryAfterSeconds ?? 30)} />
        ) : (
          <ErrorState error={formError} />
        ))}
      <PasswordField
        label={t("auth.field.passwordNew")}
        name="new-password"
        autoComplete="new-password"
        value={values.password}
        onChange={(e) => {
          setValues((v) => ({ ...v, password: e.target.value }));
          setErrors(({ password: _cleared, ...rest }) => rest);
        }}
        error={errors.password}
        hint={t("auth.field.passwordHint")}
        required
      />
      <PasswordField
        label={t("auth.field.passwordConfirm")}
        name="confirm-password"
        autoComplete="new-password"
        value={values.confirm}
        onChange={(e) => {
          setValues((v) => ({ ...v, confirm: e.target.value }));
          setErrors(({ confirm: _cleared, ...rest }) => rest);
        }}
        error={errors.confirm}
        required
      />
      <Button type="submit" size="lg" fullWidth loading={pending} disabled={cooldown > 0}>
        {t("auth.reset.submit")}
      </Button>
    </form>
  );
}

export function InvalidResetLink() {
  const { t } = useI18n();
  return (
    <section aria-labelledby="reset-invalid-title" className="space-y-4">
      <h2 id="reset-invalid-title" className="text-heading">
        {t("auth.reset.invalidTitle")}
      </h2>
      <p>{t("auth.reset.invalidBody")}</p>
      <a href="/forgot-password" className={buttonClasses({ variant: "primary", fullWidth: true })}>
        {t("auth.reset.invalidAction")}
      </a>
    </section>
  );
}
