import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { desktopDevicesQuery } from "~/lib/oauth-account-queries";

export function DesktopDevices({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const cache = useQueryClient();
  const toast = useToast();
  const title = useRef<HTMLHeadingElement>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const options = desktopDevicesQuery(userId);
  const { queryKey } = options;
  const query = useQuery(options);
  const revoke = useMutation({
    mutationFn: (id: string) => api().desktopDevices.revoke(id),
    onSuccess: async (_, id) => {
      title.current?.focus();
      setConfirm(null);
      await cache.cancelQueries({ queryKey });
      cache.setQueryData(
        queryKey,
        (data: typeof query.data) =>
          data && { devices: data.devices.filter((device) => device.id !== id) },
      );
      await cache.invalidateQueries({ queryKey });
      toast.success(t("desktop.devices.removed"));
    },
    onError: () => toast.error(t("desktop.devices.failed")),
  });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });

  return (
    <section
      id="desktop-devices"
      aria-labelledby="desktop-devices-title"
      className="mt-8 space-y-3"
    >
      <h2 ref={title} tabIndex={-1} id="desktop-devices-title" className="text-heading">
        {t("desktop.devices.title")}
      </h2>
      <p className="text-sm text-muted">{t("desktop.devices.lead")}</p>
      {query.isPending && <Skeleton className="h-16" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.devices.length === 0 && <p className="text-sm">{t("desktop.devices.empty")}</p>}
      {!!query.data?.devices.length && (
        // biome-ignore lint/a11y/noRedundantRoles: preserves list semantics in Safari when CSS hides markers.
        <ul role="list" className="space-y-3">
          {query.data.devices.map(({ id, label, linkedAt, lastSeenAt }) => (
            <li key={id} className="space-y-3 rounded-lg border border-line bg-surface p-4">
              <div className="space-y-1">
                <strong className="break-words">{label}</strong>
                <p className="text-sm text-muted">
                  {t("desktop.devices.linked")}{" "}
                  <time dateTime={linkedAt}>{date.format(new Date(linkedAt))}</time>
                </p>
                <p className="text-sm text-muted">
                  {t("desktop.devices.activity")}{" "}
                  <time dateTime={lastSeenAt}>{date.format(new Date(lastSeenAt))}</time>
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant={confirm === id ? "danger" : "secondary"}
                  disabled={revoke.isPending && revoke.variables !== id}
                  loading={revoke.isPending && revoke.variables === id}
                  aria-label={`${t(confirm === id ? "desktop.devices.confirm" : "desktop.devices.revoke")} · ${label} · ${date.format(new Date(linkedAt))}`}
                  onClick={() => (confirm === id ? revoke.mutate(id) : setConfirm(id))}
                >
                  {t(confirm === id ? "desktop.devices.confirm" : "desktop.devices.revoke")}
                </Button>
                {confirm === id && (
                  <Button
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => setConfirm(null)}
                  >
                    {t("appointment.cancel")}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
