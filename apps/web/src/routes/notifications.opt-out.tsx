import { createFileRoute } from "@tanstack/react-router";
import { PageContainer } from "~/components/pages";
import { OptOutView } from "~/features/notifications/opt-out-view";
import { createTranslator } from "~/i18n";
import { pageMeta } from "~/lib/seo";

/** Public, login-free landing page of the unsubscribe link in reminder emails. */
export const Route = createFileRoute("/notifications/opt-out")({
  validateSearch: (raw: Record<string, unknown>): { token?: string } =>
    typeof raw.token === "string" ? { token: raw.token } : {},
  head: ({ match }) => {
    const { locale, salon } = match.context;
    const t = createTranslator(locale);
    return {
      meta: pageMeta({
        title: t("optout.title"),
        description: t("optout.meta.description"),
        siteName: salon.name,
        locale,
        noindex: true,
      }),
    };
  },
  component: OptOutPage,
});

function OptOutPage() {
  const { token } = Route.useSearch();
  return (
    <PageContainer width="max-w-md">
      <div className="py-10 sm:py-16">
        <OptOutView token={token} />
      </div>
    </PageContainer>
  );
}
