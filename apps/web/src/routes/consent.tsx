import { useQuery } from "@tanstack/react-query";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { ConsentView } from "~/features/oauth/consent-view";
import { parseOAuthRequest } from "~/features/oauth/logic";
import { useRawSearch } from "~/features/oauth/use-raw-search";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { resolveAccess } from "~/lib/auth/access";
import { pageMeta } from "~/lib/seo";

/**
 * OAuth consent screen. The authorization server sends signed-in users here with the signed
 * authorization query; the decision is posted back with that same query, so the server, not this
 * page, decides what the request means.
 */
export const Route = createFileRoute("/consent")({
  beforeLoad: ({ context, location }) => {
    if (resolveAccess("account", context.session).type === "signin") {
      throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    }
  },
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("oauth.consent.titleUnnamed"),
        description: t("oauth.consent.meta.description"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: ConsentPage,
});

function ConsentPage() {
  const { t } = useI18n();
  const { session, salon } = Route.useRouteContext();
  const searchStr = useRawSearch();
  const request = parseOAuthRequest(searchStr);
  const clientQuery = useQuery({
    queryKey: ["oauth", "client", request?.clientId],
    queryFn: () => api().oauth.client(request?.clientId ?? ""),
    enabled: request !== null,
    staleTime: 60_000,
  });

  return (
    <PageContainer width="max-w-lg">
      <div className="py-10 sm:py-16">
        {!request || !session ? (
          <EmptyState
            title={t("oauth.consent.invalid.title")}
            description={t("oauth.consent.invalid.body")}
          />
        ) : clientQuery.isPending ? (
          <Skeleton className="h-96 w-full" />
        ) : clientQuery.isError ? (
          <ErrorState error={clientQuery.error} onRetry={() => void clientQuery.refetch()} />
        ) : (
          <ConsentView
            request={request}
            client={clientQuery.data}
            role={session.user.role}
            email={session.user.email}
            salonName={salon.name}
            decide={({ scopes }) =>
              api().oauth.consent({ accept: true, scopes, query: request.query })
            }
            deny={() => api().oauth.consent({ accept: false, scopes: [], query: request.query })}
          />
        )}
      </div>
    </PageContainer>
  );
}
