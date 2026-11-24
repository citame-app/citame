import { DESKTOP_CLIENT_ID } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";

import {
  desktopDevicesQuery,
  oauthAccountKey,
  oauthConnectionsQuery,
} from "~/lib/oauth-account-queries";

export function OAuthConnections({ userId }: { userId: string }) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const toast = useToast();
  const title = useRef<HTMLHeadingElement>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const options = oauthConnectionsQuery(userId);
  const query = useQuery(options);
  const revoke = useMutation({
    mutationFn: (clientId: string) => api().oauthConnections.revoke(clientId),
    onSuccess: async (_, clientId) => {
      title.current?.focus();
      setConfirm(null);
      const disconnectsDesktop = clientId === DESKTOP_CLIENT_ID;
      const filters = {
        queryKey: disconnectsDesktop ? oauthAccountKey(userId) : options.queryKey,
      };
      await queryClient.cancelQueries(filters);
      queryClient.setQueryData(
        options.queryKey,
        (data) =>
          data && { connections: data.connections.filter((app) => app.clientId !== clientId) },
      );
      if (disconnectsDesktop)
        queryClient.setQueryData(desktopDevicesQuery(userId).queryKey, { devices: [] });
      await queryClient.invalidateQueries(filters);
      toast.success(t("oauth.connections.removed"));
    },
    onError: () => toast.error(t("oauth.connections.failed")),
  });

  return (
    <section aria-labelledby="connected-apps-title" className="space-y-3">
      <h2 ref={title} tabIndex={-1} id="connected-apps-title" className="text-heading">
        {t("oauth.connections.title")}
      </h2>
      <p className="text-sm text-muted">{t("oauth.connections.lead")}</p>
      {query.isPending && <Skeleton className="h-16" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.connections.length === 0 && (
        <p className="text-sm">{t("oauth.connections.empty")}</p>
      )}
      <ul className="space-y-3">
        {query.data?.connections.map(({ clientId, name, scopes, updatedAt }) => (
          <li key={clientId} className="space-y-3 rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <strong className="break-all">
                {name?.trim() || t("oauth.connections.unnamed")}
              </strong>
              <time className="text-sm text-muted" dateTime={updatedAt}>
                {new Date(updatedAt).toLocaleDateString(locale)}
              </time>
            </div>
            <ul className="space-y-1 text-sm text-muted">
              {scopes.map((scope) => (
                <li key={scope}>{t(`oauth.scope.${scope}`)}</li>
              ))}
            </ul>
            {confirm === clientId && clientId === DESKTOP_CLIENT_ID && (
              <p id="desktop-revoke-description" className="text-sm text-muted">
                {t("oauth.connections.confirmDesktop")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                aria-describedby={
                  confirm === clientId && clientId === DESKTOP_CLIENT_ID
                    ? "desktop-revoke-description"
                    : undefined
                }
                variant={confirm === clientId ? "danger" : "secondary"}
                disabled={revoke.isPending && revoke.variables !== clientId}
                loading={revoke.isPending && revoke.variables === clientId}
                onClick={() =>
                  confirm === clientId ? revoke.mutate(clientId) : setConfirm(clientId)
                }
              >
                {t(confirm === clientId ? "oauth.connections.confirm" : "oauth.connections.revoke")}
              </Button>
              {confirm === clientId && (
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
    </section>
  );
}
