import { queryOptions } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { PageContainer, PageHeading } from "~/components/pages";
import { PublicReviews } from "~/features/reputation/reviews";
import { createTranslator } from "~/i18n";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { pageMeta } from "~/lib/seo";
export const Route = createFileRoute("/reviews")({
  loader: ({ context }) =>
    context.queryClient.ensureQueryData(
      queryOptions({
        queryKey: ["reviews", "public", "", undefined],
        queryFn: () => api().reviews.public(),
      }),
    ),
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("reviews.title"),
        description: t("reviews.publicLead"),
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
      <div className="py-8 sm:py-12">
        <PageHeading title={t("reviews.title")} />
        <PublicReviews />
      </div>
    </PageContainer>
  );
}
