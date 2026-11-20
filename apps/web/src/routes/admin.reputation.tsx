import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { BookingLinks } from "~/features/acquisition/booking-links";
import { SocialCreative } from "~/features/acquisition/social-creative";
import { adminHead } from "~/features/admin/route-head";
import { PortfolioAdmin } from "~/features/reputation/portfolio";
import { ReviewRequests } from "~/features/reputation/review-requests";
import { ReviewModeration } from "~/features/reputation/reviews";
import { useI18n } from "~/i18n/react";
const tabs = ["reviews", "requests", "portfolio", "entry", "creative"] as const;
type ReputationTab = (typeof tabs)[number];
const isTab = (value: unknown): value is ReputationTab => tabs.some((tab) => value === tab);
export const Route = createFileRoute("/admin/reputation")({
  validateSearch: (search: Record<string, unknown>): { tab?: ReputationTab } =>
    isTab(search.tab) ? { tab: search.tab } : {},
  head: adminHead("admin.nav.reputation"),
  component: Page,
});
function Page() {
  const { t } = useI18n();
  const { salon } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab = search.tab ?? "reviews";
  return (
    <div className="view-reputation">
      <PageHeading title={t("admin.nav.reputation")} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search: isTab(value) && value !== "reviews" ? { tab: value } : {},
          })
        }
        label={t("admin.nav.reputation")}
        items={[
          { value: "reviews", label: t("reviews.title") },
          { value: "requests", label: t("reviews.request.title") },
          { value: "portfolio", label: t("portfolio.title") },
          { value: "entry", label: t("acquisition.title") },
          { value: "creative", label: t("social.title") },
        ]}
      >
        <TabPanel value="reviews">
          <ReviewModeration />
        </TabPanel>
        <TabPanel value="requests">
          <ReviewRequests />
        </TabPanel>
        <TabPanel value="portfolio">
          <PortfolioAdmin />
        </TabPanel>
        <TabPanel value="entry">
          <BookingLinks salonName={salon.name} />
        </TabPanel>
        <TabPanel value="creative">
          <SocialCreative salonName={salon.name} />
        </TabPanel>
      </Tabs>
    </div>
  );
}
