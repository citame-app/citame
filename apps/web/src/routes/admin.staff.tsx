import { permissionsFor } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { StaffView, validateStaffSearch } from "~/features/admin/staff/staff-view";
import { useI18n } from "~/i18n/react";

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
  if (!session) return null;
  const own = !permissionsFor(session.user.role, session.accessPreset).editSchedules;
  return (
    <div className="view-staff">
      <PageHeading
        title={t(own ? "staff.titleOwn" : "staff.title")}
        lead={t(own ? "staff.leadOwn" : "staff.lead")}
      />
      <StaffView
        search={search}
        onSearchChange={(next) => void navigate({ search: next })}
        role={session.user.role}
        accessPreset={session.accessPreset}
        ownStaffId={session.staffId}
      />
    </div>
  );
}
