import type { ButtonHTMLAttributes } from "react";
import { cn } from "~/lib/cn";
import { Spinner } from "./icons";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap select-none " +
  "transition-[background-color,color,box-shadow,transform,opacity] duration-150 " +
  "active:scale-[0.98] disabled:opacity-60 disabled:active:scale-100 aria-disabled:opacity-60";

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover",
  secondary: "border border-line-strong bg-surface text-fg hover:bg-sunken",
  ghost: "text-accent-text hover:bg-accent-soft",
  danger: "bg-danger-fg text-canvas shadow-sm hover:opacity-90",
};

const sizes: Record<ButtonSize, string> = {
  md: "min-h-11 px-5 text-[0.95rem]",
  lg: "min-h-11 px-6 py-3.5 text-base",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
} = {}): string {
  return cn(base, variants[variant], sizes[size], fullWidth && "w-full");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
}

export function Button({
  variant,
  size,
  loading = false,
  fullWidth,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonClasses({ variant, size, fullWidth }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
