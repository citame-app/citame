import { permissionsFor } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "~/components/pages";
import { AccountingView } from "~/features/admin/commerce/accounting-view";
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
  const [section, setSection] = useState<"overview" | "clients" | "financial" | "commissions">(
    "overview",
  );
  const [visited, setVisited] = useState(() => new Set<string>(["overview"]));
  const permissions = permissionsFor(session?.user.role ?? "client", session?.accessPreset);
  if (!session) return null;
  const all = permissions.allCalendars;
  return (
    <div className="view-reports">
      <PageHeading title={t("reports.title")} lead={t(all ? "reports.lead" : "reports.leadOwn")} />
      <nav className="commerce-section-nav" aria-label={t("reports.title")}>
        {(
          [
            "overview",
            ...(permissions.financialReports ? ["clients", "financial"] : []),
            ...(permissions.commerce ? ["commissions"] : []),
          ] as const
        ).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={section === value}
            onClick={() => {
              setSection(value as typeof section);
              setVisited((current) => new Set([...current, value]));
            }}
          >
            {t(
              value === "overview"
                ? "pos.overview"
                : value === "clients"
                  ? "reports.clients"
                  : value === "financial"
                    ? "pos.financialReports"
                    : "accounting.commissions",
            )}
          </button>
        ))}
      </nav>
      <div
        hidden={section !== "overview" && !(section === "clients" && permissions.financialReports)}
      >
        <ReportsView
          search={search}
          onSearchChange={(next) => void navigate({ search: next, replace: true })}
          role={all ? "owner" : session.user.role}
          showClients={section === "clients" && permissions.financialReports}
        />
      </div>
      {visited.has("financial") && permissions.financialReports && (
        <div hidden={section !== "financial"}>
          <AccountingView role="owner" section="reports" />
        </div>
      )}
      {visited.has("commissions") && permissions.commerce && (
        <div hidden={section !== "commissions"}>
          <AccountingView
            role={permissions.financialReports ? "owner" : session.user.role}
            section="commissions"
          />
        </div>
      )}
    </div>
  );
}
