import { idSchema } from "@sob/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { ServicesView } from "~/features/admin/services/services-view";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/services")({
  validateSearch: (raw: Record<string, unknown>): { service?: string } =>
    idSchema.safeParse(raw.service).success ? { service: String(raw.service) } : {},
  head: adminHead("services.title"),
  component: ServicesPage,
});

function ServicesPage() {
  const { t } = useI18n();
  const search = Route.useSearch();
  return (
    <div className="view-services">
      <PageHeading title={t("services.title")} lead={t("services.lead")} />
      <ServicesView initialServiceId={search.service} />
    </div>
  );
}
