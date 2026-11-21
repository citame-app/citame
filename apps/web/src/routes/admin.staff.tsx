import { permissionsFor } from "@sob/contracts";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { AccountingView } from "~/features/admin/commerce/accounting-view";
import { ResourcesPanel } from "~/features/admin/resources/resources-panel";
import { adminHead } from "~/features/admin/route-head";
import { StaffView, validateStaffSearch } from "~/features/admin/staff/staff-view";
import { TeamShifts } from "~/features/admin/staff/team-shifts";
import { useI18n } from "~/i18n/react";
import { adminServicesQuery } from "~/lib/admin-queries";

export const Route = createFileRoute("/admin/staff")({
  validateSearch: validateStaffSearch,
  head: adminHead("staff.title"),
  component: StaffPage,
});

function StaffPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const permissions = permissionsFor(session?.user.role ?? "client", session?.accessPreset);
  const section =
    (search.section === "resources" && permissions.editCatalog) ||
    (search.section === "commissions" && permissions.commerce) ||
    search.section === "shifts"
      ? search.section
      : "employees";
  const services = useQuery({
    ...adminServicesQuery,
    enabled: section === "resources" && permissions.editCatalog,
  });
  if (!session) return null;
  const own = !permissions.editSchedules;
  return (
    <div className="view-staff">
      <PageHeading
        title={t(own ? "staff.titleOwn" : "staff.title")}
        lead={t(own ? "staff.leadOwn" : "staff.lead")}
      />
      <nav className="commerce-section-nav" aria-label={t("staff.title")}>
        {(
          [
            "employees",
            "shifts",
            ...(permissions.editCatalog ? ["resources"] : []),
            ...(permissions.commerce ? ["commissions"] : []),
          ] as const
        ).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={section === value}
            onClick={() => {
              const next = value as typeof section;
              void navigate({
                search: {
                  ...search,
                  section: next === "employees" ? undefined : next,
                  tab: next === "shifts" && own ? "dates" : search.tab,
                },
              });
            }}
          >
            {t(
              value === "employees"
                ? "pos.employees"
                : value === "shifts"
                  ? "shifts.title"
                  : value === "resources"
                    ? "pos.resources"
                    : "accounting.commissions",
            )}
          </button>
        ))}
      </nav>
      {section === "shifts" && !own && (
        <TeamShifts
          week={search.week}
          onWeekChange={(week) => void navigate({ search: { ...search, week } })}
          onOpenMember={(member, week) => void navigate({ search: { member, week, tab: "dates" } })}
        />
      )}
      {(section === "employees" || (section === "shifts" && own)) && (
        <StaffView
          search={search}
          onSearchChange={(next) =>
            void navigate({ search: { week: search.week, section: search.section, ...next } })
          }
          role={session.user.role}
          accessPreset={session.accessPreset}
          ownStaffId={session.staffId}
          actorUserId={session.user.id}
        />
      )}
      {section === "resources" && permissions.editCatalog && (
        <ResourcesPanel services={services.data ?? []} />
      )}
      {section === "commissions" && permissions.commerce && (
        <AccountingView
          role={permissions.financialReports ? "owner" : session.user.role}
          section="commissions"
        />
      )}
    </div>
  );
}
