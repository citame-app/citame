import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { buttonClasses } from "~/components/ui/button";
import { adminHead } from "~/features/admin/route-head";
import { CombinationsPanel } from "~/features/admin/services/combinations-panel";
import { ProcessingPanel } from "~/features/admin/services/processing-panel";
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
      <div className="mb-6 flex flex-wrap gap-3">
        <a
          href="#treatment-combinations"
          className={`${buttonClasses({ variant: "secondary" })} max-w-full py-2 whitespace-normal!`}
        >
          {t("combinations.title")}
        </a>
        <a
          href="#processing-settings"
          className={`${buttonClasses({ variant: "secondary" })} max-w-full py-2 whitespace-normal!`}
        >
          {t("timing.processingTitle")}
        </a>
      </div>
      <ServicesView />
      <CombinationsPanel />
      <ProcessingPanel />
    </>
  );
}
