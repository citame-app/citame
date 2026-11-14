import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { validateReportsSearch } from "~/features/admin/reports/range";
import { ReportsView } from "~/features/admin/reports/reports-view";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/reports")({
  validateSearch: validateReportsSearch,
  head: adminHead("reports.title"),
  component: ReportsPage,
});

function ReportsPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!session) return null;
  return (
    <>
      <PageHeading
        title={t("reports.title")}
        lead={t(session.user.role === "owner" ? "reports.lead" : "reports.leadOwn")}
      />
      <ReportsView
        search={search}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
        role={session.user.role}
      />
    </>
  );
}
