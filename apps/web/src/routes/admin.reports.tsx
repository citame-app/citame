import { permissionsFor } from "@sob/contracts";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "~/components/pages";
import { AccountingView, SalesReport } from "~/features/admin/commerce/accounting-view";
import {
  type ReportSection,
  resolveRange,
  validateReportsSearch,
} from "~/features/admin/reports/range";
import { ReportsView } from "~/features/admin/reports/reports-view";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/reports")({
  validateSearch: validateReportsSearch,
  head: adminHead("reports.title"),
  component: ReportsPage,
});

function ReportsPage() {
  const { t, timeZone } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [visited, setVisited] = useState(() => new Set<ReportSection>());
  const permissions = permissionsFor(session?.user.role ?? "client", session?.accessPreset);
  if (!session) return null;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
  const applyFinancialFilters = ({
    from,
    to,
    staffId,
  }: {
    from: string;
    to: string;
    staffId?: string;
  }) =>
    void navigate({
      search: (current) => ({ ...current, preset: "custom", from, to, staff: staffId }),
    });
  if (search.client) {
    const range = resolveRange(search, today);
    return (
      <div className="view-reports">
        <PageHeading title={t("accounting.clientSales")} />
        <Link
          to="/admin/reports"
          search={{ preset: "last30" }}
          className="inline-flex min-h-11 items-center text-sm font-medium text-accent-text hover:underline"
        >
          {t("accounting.allReports")}
        </Link>
        {permissions.financialReports && permissions.clients && permissions.commerce ? (
          <SalesReport
            key={JSON.stringify([search.client, range.from, range.to, search.staff])}
            clientId={search.client}
            filters={{ ...range, staffId: search.staff }}
            onApply={applyFinancialFilters}
          />
        ) : (
          <p role="status">{t("accounting.clientReportRestricted")}</p>
        )}
      </div>
    );
  }
  const all = permissions.allCalendars;
  const sections: ReportSection[] = ["overview"];
  if (permissions.financialReports) sections.push("clients", "financial");
  if (permissions.commerce) sections.push("commissions");
  const requestedSection = search.section ?? "overview";
  const section = sections.includes(requestedSection) ? requestedSection : "overview";
  const financialRange =
    search.preset === "custom" ? resolveRange(search, today) : { from: today, to: today };
  return (
    <div className="view-reports">
      <PageHeading title={t("reports.title")} lead={t(all ? "reports.lead" : "reports.leadOwn")} />
      <nav className="commerce-section-nav" aria-label={t("reports.title")}>
        {sections.map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={section === value}
            onClick={() => {
              setVisited((current) => new Set([...current, section]));
              void navigate({ search: (current) => ({ ...current, section: value }) });
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
          onSearchChange={(next) =>
            void navigate({
              search: (current) => ({ ...next, section: current.section }),
              replace: true,
            })
          }
          role={all ? "owner" : session.user.role}
          showClients={section === "clients" && permissions.financialReports}
        />
      </div>
      {(section === "financial" || visited.has("financial")) && permissions.financialReports && (
        <div hidden={section !== "financial"}>
          <AccountingView
            key={JSON.stringify([financialRange.from, financialRange.to, search.staff])}
            role="owner"
            section="reports"
            salesFilters={{ ...financialRange, staffId: search.staff }}
            onApplySalesFilters={applyFinancialFilters}
          />
        </div>
      )}
      {(section === "commissions" || visited.has("commissions")) && permissions.commerce && (
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
