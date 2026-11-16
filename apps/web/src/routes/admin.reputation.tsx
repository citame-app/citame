import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { BookingLinks } from "~/features/acquisition/booking-links";
import { adminHead } from "~/features/admin/route-head";
import { PortfolioAdmin } from "~/features/reputation/portfolio";
import { ReviewModeration } from "~/features/reputation/reviews";
import { useI18n } from "~/i18n/react";
export const Route = createFileRoute("/admin/reputation")({
  validateSearch: (search: Record<string, unknown>): { tab?: "reviews" | "portfolio" | "entry" } =>
    search.tab === "portfolio"
      ? { tab: "portfolio" }
      : search.tab === "entry"
        ? { tab: "entry" }
        : {},
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
    <>
      <PageHeading title={t("admin.nav.reputation")} />
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search:
              value === "portfolio"
                ? { tab: "portfolio" }
                : value === "entry"
                  ? { tab: "entry" }
                  : {},
          })
        }
        label={t("admin.nav.reputation")}
        items={[
          { value: "reviews", label: t("reviews.title") },
          { value: "portfolio", label: t("portfolio.title") },
          { value: "entry", label: t("acquisition.title") },
        ]}
      >
        <TabPanel value="reviews">
          <ReviewModeration />
        </TabPanel>
        <TabPanel value="portfolio">
          <PortfolioAdmin />
        </TabPanel>
        <TabPanel value="entry">
          <BookingLinks salonName={salon.name} />
        </TabPanel>
      </Tabs>
    </>
  );
}
