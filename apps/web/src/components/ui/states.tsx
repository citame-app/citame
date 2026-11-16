import { type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError } from "~/lib/api/client";
import { cn } from "~/lib/cn";
import { Button } from "./button";
import { AlertIcon, SparkleIcon, WifiOffIcon } from "./icons";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div aria-hidden="true" className={cn("sob-skeleton rounded-md", className)} {...props} />;
}

export function EmptyState({
  title,
  description,
  children,
  icon,
}: {
  title: string;
  description?: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-line-strong bg-surface px-6 py-10 text-center">
      <span className="mb-4 grid size-12 place-items-center rounded-full bg-accent-soft text-accent-soft-fg">
        {icon ?? <SparkleIcon width={24} height={24} />}
      </span>
      <h2 className="text-heading">{title}</h2>
      {description && <p className="mt-1.5 max-w-sm text-muted">{description}</p>}
      {children && <div className="mt-5 flex flex-wrap justify-center gap-3">{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t } = useI18n();
  let title = t("error.generic.title");
  let body = t("error.generic.body");
  let icon = <AlertIcon width={24} height={24} />;
  if (error instanceof NetworkError) {
    title = t("error.offline.title");
    body = t("error.offline.body");
    icon = <WifiOffIcon width={24} height={24} />;
  } else if (error instanceof ApiError && error.code === "rate_limited") {
    title = t("error.rateLimited.title");
    body = t("error.rateLimited.body", { count: error.retryAfterSeconds ?? 30 });
  } else if (
    error instanceof ApiError &&
    (error.code === "intake_required" || error.code === "booking_intent_conflict")
  ) {
    body = t(error.code === "intake_required" ? "intake.changed" : "intake.conflict");
  }
  return (
    <div
      role="alert"
      className="flex flex-col items-center rounded-xl border border-danger-fg/30 bg-danger-soft px-6 py-8 text-center text-danger-fg"
    >
      <span className="mb-3">{icon}</span>
      <p className="font-display text-lg font-semibold">{title}</p>
      <p className="mt-1 max-w-sm text-[0.95rem]">{body}</p>
      {onRetry && (
        <Button variant="secondary" className="mt-5" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

/** Tracks the browser's connectivity so offline is a designed state, not a silent failure. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function OfflineBanner() {
  const { t } = useI18n();
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-warning-soft px-4 py-2 text-center text-sm font-medium text-warning-fg"
    >
      <WifiOffIcon width={18} height={18} />
      {t("error.offline.banner")}
    </div>
  );
}
