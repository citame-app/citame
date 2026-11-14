import { createFileRoute } from "@tanstack/react-router";
import { PreferencesForm } from "~/features/notifications/preferences-form";
import { useI18n } from "~/i18n/react";

export const Route = createFileRoute("/account/notifications")({ component: NotificationsPage });

function NotificationsPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  return (
    <section aria-labelledby="notify-title" className="max-w-lg">
      <h2 id="notify-title" className="text-heading">
        {t("notify.title")}
      </h2>
      <p className="mt-1 mb-6 text-muted">{t("notify.lead")}</p>
      {/* Staff and owners have no booking profile, hence nothing to configure. */}
      {session?.clientId ? <PreferencesForm /> : null}
    </section>
  );
}
