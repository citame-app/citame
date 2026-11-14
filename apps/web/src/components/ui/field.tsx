import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { EyeIcon, EyeOffIcon } from "./icons";

export interface TextFieldProps extends Omit<ComponentProps<"input">, "id"> {
  label: string;
  hint?: string;
  error?: string;
  /** Rendered inside the input box on the right (e.g. the password visibility toggle). */
  trailing?: ReactNode;
}

const inputClasses =
  "block min-h-11 w-full rounded-md border bg-surface px-3.5 py-2.5 text-base text-fg " +
  "placeholder:text-muted/70 transition-colors disabled:opacity-60 " +
  "border-line-strong hover:border-fg/60 focus:border-ring read-only:bg-sunken read-only:text-muted";

export function TextField({ label, hint, error, trailing, className, ...props }: TextFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy || undefined}
          {...props}
          className={cn(
            inputClasses,
            trailing ? "pr-12" : "",
            error ? "border-danger-fg" : "",
            "text-base",
          )}
        />
        {trailing && (
          <div className="absolute inset-y-0 right-0 flex items-center pr-1">{trailing}</div>
        )}
      </div>
      {hint && (
        <p id={hintId} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="mt-1.5 text-sm font-medium text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}

export function PasswordField(props: Omit<TextFieldProps, "type" | "trailing">) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(false);
  return (
    <TextField
      {...props}
      type={visible ? "text" : "password"}
      trailing={
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-pressed={visible}
          aria-label={visible ? t("field.password.hide") : t("field.password.show")}
          className="inline-flex size-11 items-center justify-center rounded-md text-muted hover:text-fg"
        >
          {visible ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      }
    />
  );
}
