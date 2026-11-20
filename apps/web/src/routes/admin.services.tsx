import { idSchema } from "@sob/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { TabPanel, Tabs } from "~/components/ui/tabs";
import { adminHead } from "~/features/admin/route-head";
import { CombinationsPanel } from "~/features/admin/services/combinations-panel";
import { ProcessingPanel } from "~/features/admin/services/processing-panel";
import { ServicesView } from "~/features/admin/services/services-view";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/services")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { view?: "combinations" | "processing"; service?: string } => ({
    ...(idSchema.safeParse(search.service).success ? { service: String(search.service) } : {}),
    ...(search.view === "combinations" || search.view === "processing"
      ? { view: search.view }
      : {}),
  }),
  head: adminHead("services.title"),
  component: ServicesPage,
});

function ServicesPage() {
  const { t } = useI18n();
  const { view, service } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <div className="view-services">
      <PageHeading title={t("services.title")} lead={t("services.lead")} />
      <Tabs
        label={t("services.title")}
        value={view ?? "catalog"}
        onValueChange={(value) =>
          void navigate({
            search: value === "catalog" ? {} : { view: value as "combinations" | "processing" },
          })
        }
        items={[
          { value: "catalog", label: t("services.catalogTab") },
          { value: "combinations", label: t("services.combinationsTab") },
          { value: "processing", label: t("services.processingTab") },
        ]}
      >
        <TabPanel value="catalog">
          <ServicesView initialServiceId={service} />
        </TabPanel>
        <TabPanel value="combinations">
          <CombinationsPanel />
        </TabPanel>
        <TabPanel value="processing">
          <ProcessingPanel />
        </TabPanel>
      </Tabs>
    </div>
  );
}
