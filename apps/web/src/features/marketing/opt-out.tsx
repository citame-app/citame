import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

export function MarketingOptOut({ token }: { token?: string }) {
  const { t } = useI18n();
  const preview = useQuery({
    queryKey: ["marketing-opt-out", token],
    queryFn: () => api().marketing.optOutPreview(token ?? ""),
    enabled: Boolean(token),
    retry: false,
  });
  const confirm = useMutation({ mutationFn: () => api().marketing.optOut(token ?? "") });
  if (!token || preview.isError)
    return (
      <div role="alert" className="space-y-4">
        <h1 className="text-title">{t("optout.invalid.title")}</h1>
        <p className="text-muted">{t("optout.invalid.lead")}</p>
        <Link
          to="/account/notifications"
          className="inline-flex min-h-11 items-center text-accent-text underline"
        >
          {t("optout.manage")}
        </Link>
      </div>
    );
  if (!preview.data) return <Skeleton className="h-40" />;
  return (
    <div className="space-y-5">
      <h1 className="text-title">{t("marketing.optoutTitle")}</h1>
      <p className="text-muted">{t("marketing.consentHelp")}</p>
      {confirm.isSuccess ? (
        <p role="status" className="font-semibold">
          {t("marketing.optoutDone")}
        </p>
      ) : (
        <>
          <p>
            {t("marketing.optoutHelp")} ·{" "}
            {t(preview.data.channel === "email" ? "marketing.email" : "marketing.sms")}
          </p>
          {confirm.isError && <ErrorState error={confirm.error} />}
          <Button onClick={() => confirm.mutate()} loading={confirm.isPending}>
            {t("marketing.optoutAction")}
          </Button>
        </>
      )}
      <Link
        to="/account/notifications"
        className="inline-flex min-h-11 items-center text-accent-text underline"
      >
        {t("optout.manage")}
      </Link>
    </div>
  );
}
