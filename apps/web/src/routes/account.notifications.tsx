import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { MarketingConsent } from "~/features/marketing/consent";
import { PreferencesForm } from "~/features/notifications/preferences-form";
import { StampNotices } from "~/features/notifications/stamp-notices";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/account/notifications")({ component: NotificationsPage });

function NotificationsPage() {
  const { t } = useI18n();
  const [marketingDirty, setMarketingDirty] = useState(false);
  const { session } = Route.useRouteContext();
  if (!session?.clientId) return null;
  return (
    <div className="max-w-lg space-y-8">
      <StampNotices key={session.user.id} mode="client" userId={session.user.id} headingLevel={2} />
      <section aria-labelledby="notify-preferences">
        <h2 id="notify-preferences" className="text-heading">
          {t("notify.preferencesTitle")}
        </h2>
        <p className="mt-1 mb-6 text-muted">{t("notify.lead")}</p>
        <PreferencesForm />
        <UnsavedGuard dirty={marketingDirty} />
        <div className="mt-8">
          <MarketingConsent
            mode="self"
            clientId={session.clientId}
            editable
            onDirtyChange={setMarketingDirty}
          />
        </div>
      </section>
    </div>
  );
}
