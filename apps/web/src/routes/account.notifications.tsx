import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { MarketingConsent } from "~/features/marketing/consent";
import { PreferencesForm } from "~/features/notifications/preferences-form";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/account/notifications")({ component: NotificationsPage });

function NotificationsPage() {
  const { t } = useI18n();
  const [marketingDirty, setMarketingDirty] = useState(false);
  const { session } = Route.useRouteContext();
  return (
    <section aria-labelledby="notify-title" className="max-w-lg">
      <h2 id="notify-title" className="text-heading">
        {t("notify.title")}
      </h2>
      <p className="mt-1 mb-6 text-muted">{t("notify.lead")}</p>
      {/* Staff and owners have no booking profile, hence nothing to configure. */}
      {session?.clientId ? (
        <>
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
        </>
      ) : null}
    </section>
  );
}
