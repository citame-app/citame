import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { EmptyState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/")({ component: AdminHome });

function AdminHome() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  return (
    <>
      <PageHeading
        title={t("admin.title")}
        lead={session ? t("admin.welcome", { name: session.user.name }) : undefined}
      />
      <EmptyState title={t("admin.placeholder.title")} description={t("admin.placeholder.body")} />
    </>
  );
}
