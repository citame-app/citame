import { type SelectHTMLAttributes, type TextareaHTMLAttributes, useId } from "react";
import { cn } from "~/lib/cn";
import { ChevronDownIcon } from "./icons";

const controlClasses =
  "block min-h-11 w-full rounded-md border bg-surface px-3.5 py-2.5 text-base text-fg transition-colors " +
  "disabled:opacity-60 border-line-strong hover:border-fg/60 focus:border-ring";

function Message({ id, hint, error }: { id: string; hint?: string; error?: string }) {
  return (
    <>
      {hint && (
        <p id={`${id}-hint`} className="mt-1.5 text-sm text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-sm font-medium text-danger-fg">
          {error}
        </p>
      )}
    </>
  );
}

const describedBy = (id: string, hint?: string, error?: string) =>
  [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

export interface SelectFieldProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id" | "onChange" | "value"> {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  hint?: string;
  error?: string;
  /** Visually hide the label (the control keeps its accessible name). */
  hideLabel?: boolean;
}

/** Native select: the best keyboard, screen reader and mobile behavior for free. */
export function SelectField({
  label,
  value,
  options,
  onChange,
  hint,
  error,
  hideLabel,
  className,
  ...props
}: SelectFieldProps) {
  const id = useId();
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className={cn("mb-1.5 block text-sm font-medium text-fg", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          {...props}
          className={cn(controlClasses, "appearance-none pr-10", error && "border-danger-fg")}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted" />
      </div>
      <Message id={id} hint={hint} error={error} />
    </div>
  );
}

export interface TextAreaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  hint?: string;
  error?: string;
}

export function TextAreaField({ label, hint, error, className, ...props }: TextAreaFieldProps) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-fg">
        {label}
      </label>
      <textarea
        id={id}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        className={cn(controlClasses, "resize-y", error && "border-danger-fg")}
      />
      <Message id={id} hint={hint} error={error} />
    </div>
  );
}
