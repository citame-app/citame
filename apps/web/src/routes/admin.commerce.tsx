import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { CommerceView } from "~/features/admin/commerce/commerce-view";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";
export const Route = createFileRoute("/admin/commerce")({
  head: adminHead("commerce.title"),
  component: SalesPage,
});
function SalesPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  if (!session) return null;
  return (
    <>
      <PageHeading title={t("commerce.title")} lead={t("commerce.lead")} />
      <CommerceView role={session.user.role} accessPreset={session.accessPreset} />
    </>
  );
}
