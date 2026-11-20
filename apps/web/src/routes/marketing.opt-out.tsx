import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { MarketingOptOut } from "~/features/marketing/opt-out";
import { createTranslator } from "~/i18n";
import { pageMeta } from "~/lib/seo";

export const Route = createFileRoute("/marketing/opt-out")({
  validateSearch: (raw: Record<string, unknown>): { token?: string } =>
    typeof raw.token === "string" && raw.token.length <= 1024 ? { token: raw.token } : {},
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("marketing.optoutTitle"),
        description: t("marketing.optoutHelp"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: Page,
});
function Page() {
  const { token } = Route.useSearch();
  return (
    <PageContainer width="max-w-md">
      <div className="py-12">
        <MarketingOptOut token={token} />
      </div>
    </PageContainer>
  );
}
