import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

/**
 * Landing page of the unsubscribe link in reminder emails. Opening it only describes the
 * action (mail scanners prefetch links); the visitor confirms with a button, no login needed.
 */
export function OptOutView({ token }: { token: string | undefined }) {
  const { t } = useI18n();
  const preview = useQuery({
    queryKey: ["opt-out", token],
    queryFn: () => api().optOut.preview(token ?? ""),
    enabled: Boolean(token),
    retry: false,
  });
  const confirm = useMutation({ mutationFn: () => api().optOut.confirm(token ?? "") });

  if (!token || preview.isError) {
    return (
      <div role="alert">
        <h1 className="text-title">{t("optout.invalid.title")}</h1>
        <p className="mt-3 text-muted">{t("optout.invalid.lead")}</p>
        <Link
          to="/account/notifications"
          className="mt-6 inline-block font-medium text-accent-soft-fg underline"
        >
          {t("optout.manage")}
        </Link>
      </div>
    );
  }
  if (!preview.data) return <Skeleton className="h-40" />;

  if (confirm.isSuccess) {
    return (
      <div role="status">
        <h1 className="text-title">{t("optout.done.title")}</h1>
        <p className="mt-3 text-muted">{t("optout.done.lead")}</p>
        <Link
          to="/account/notifications"
          className="mt-6 inline-block font-medium text-accent-soft-fg underline"
        >
          {t("optout.manage")}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-title">{t("optout.title")}</h1>
      <p className="mt-3 text-muted">
        {preview.data.optedOut ? t("optout.already") : t("optout.lead.email")}
      </p>
      {confirm.isError && (
        <p role="alert" className="mt-3 font-medium text-danger-fg">
          {t("optout.failed")}
        </p>
      )}
      {!preview.data.optedOut && (
        <Button
          className="mt-6"
          size="lg"
          loading={confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {t("optout.confirm")}
        </Button>
      )}
    </div>
  );
}
