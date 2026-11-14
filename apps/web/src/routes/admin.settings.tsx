import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { SettingsView } from "~/features/admin/settings/settings-view";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/settings")({
  head: adminHead("settings.title"),
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useI18n();
  return (
    <>
      <PageHeading title={t("settings.title")} lead={t("settings.lead")} />
      <SettingsView />
    </>
  );
}
