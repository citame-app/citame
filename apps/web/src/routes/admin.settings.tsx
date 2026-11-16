import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeading } from "~/components/pages";
import { SectionIndex } from "~/components/section-index";
import { adminHead } from "~/features/admin/route-head";
import { BookingPolicyForm } from "~/features/admin/settings/booking-policy-form";
import { SettingsView } from "~/features/admin/settings/settings-view";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { IntakeAdmin } from "~/features/intake/form-admin";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/admin/settings")({
  head: adminHead("settings.title"),
  component: SettingsPage,
});

function SettingsPage() {
  const { t } = useI18n();
  const [intakeDirty, setIntakeDirty] = useState(false);
  return (
    <>
      <UnsavedGuard dirty={intakeDirty} />
      <PageHeading title={t("settings.title")} lead={t("settings.lead")} />
      <SectionIndex
        label={t("settings.title")}
        items={[
          { id: "salon-settings", label: t("settings.title") },
          { id: "booking-policy", label: t("protection.title") },
          { id: "intake-settings", label: t("intake.title") },
        ]}
      />
      <div id="salon-settings" className="settings-section">
        <SettingsView />
      </div>
      <div id="booking-policy" className="settings-section mt-8">
        <BookingPolicyForm />
      </div>
      <div id="intake-settings" className="settings-section mt-8">
        <IntakeAdmin onDirtyChange={setIntakeDirty} />
      </div>
    </>
  );
}
