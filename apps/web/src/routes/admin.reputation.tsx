import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { ReviewModeration } from "~/features/reputation/reviews";
import { useI18n } from "~/i18n/react";
export const Route = createFileRoute("/admin/reputation")({
  head: adminHead("reviews.title"),
  component: Page,
});
function Page() {
  const { t } = useI18n();
  return (
    <>
      <PageHeading title={t("reviews.title")} />
      <ReviewModeration />
    </>
  );
}
