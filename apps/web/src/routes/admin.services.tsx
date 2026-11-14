import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { ServicesView } from "~/features/admin/services/services-view";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/services")({
  head: adminHead("services.title"),
  component: ServicesPage,
});

function ServicesPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeading title={t("services.title")} lead={t("services.lead")} />
      <ServicesView />
    </>
  );
}
