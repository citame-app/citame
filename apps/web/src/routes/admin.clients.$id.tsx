import { permissionsFor } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { ClientDetail } from "~/features/admin/clients/client-detail";
import { ClientDirectory } from "~/features/admin/clients/client-directory";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/clients/$id")({
  head: adminHead("clients.title"),
  component: ClientPage,
});

function ClientPage() {
  const { t } = useI18n();
  const { id } = Route.useParams();
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  if (!session) return null;
  return (
    <>
      <PageHeading title={t("clients.title")} lead={t("clients.lead")} />
      <div className="client-workspace">
        <ClientDirectory selected={id} />
        <div className="min-w-0">
          <ClientDetail
            key={id}
            clientId={id}
            accessPreset={session.accessPreset}
            role={
              permissionsFor(session.user.role, session.accessPreset).deleteClients
                ? "owner"
                : session.user.role
            }
            onDeleted={() =>
              void navigate({
                to: "/admin/clients",
                search: { page: 1, sort: "name", order: "asc" },
              })
            }
          />
        </div>
      </div>
    </>
  );
}
