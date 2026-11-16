import { queryOptions } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { PublicPortfolio } from "~/features/reputation/portfolio";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { pageMeta } from "~/lib/seo";
export const Route = createFileRoute("/portfolio")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      queryOptions({
        queryKey: ["portfolio", "public", "", undefined],
        queryFn: () => api().portfolio.public(),
      }),
    ),
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("portfolio.title"),
        description: t("portfolio.publicLead"),
        siteName: salon.name,
        locale,
      }),
    };
  },
  component: Page,
});
function Page() {
  const { t } = useI18n();
  return (
    <PageContainer>
      <div className="public-collection py-8 sm:py-12">
        <PageHeading title={t("portfolio.title")} />
        <PublicPortfolio />
      </div>
    </PageContainer>
  );
}
