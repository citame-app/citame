import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ClientDetail } from "~/features/admin/clients/client-detail";
import { adminHead } from "~/features/admin/route-head";

export const Route = createFileRoute("/admin/clients/$id")({
  head: adminHead("clients.title"),
  component: ClientPage,
});

function ClientPage() {
  const { id } = Route.useParams();
  const { session } = Route.useRouteContext();
  const navigate = useNavigate();
  if (!session) return null;
  return (
    <ClientDetail
      clientId={id}
      role={session.user.role}
      onDeleted={() =>
        void navigate({ to: "/admin/clients", search: { page: 1, sort: "name", order: "asc" } })
      }
    />
  );
}
