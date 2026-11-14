import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { ClientsView } from "~/features/admin/clients/clients-view";
import { validateClientsSearch } from "~/features/admin/clients/search";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/clients/")({
  validateSearch: validateClientsSearch,
  head: adminHead("clients.title"),
  component: ClientsPage,
});

function ClientsPage() {
  const { t } = useI18n();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  return (
    <>
      <PageHeading title={t("clients.title")} lead={t("clients.lead")} />
      <ClientsView
        search={search}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
        onOpenClient={(id) => void navigate({ to: "/admin/clients/$id", params: { id } })}
      />
    </>
  );
}
