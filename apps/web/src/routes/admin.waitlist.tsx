import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { adminHead } from "~/features/admin/route-head";
import { WaitlistView } from "~/features/waitlist/waitlist-view";
import { useI18n } from "~/i18n/react";
import { calendarScope } from "~/lib/admin-queries";
export const Route = createFileRoute("/admin/waitlist")({
  head: adminHead("waitlist.title"),
  component: WaitlistPage,
});
function WaitlistPage() {
  const { t } = useI18n();
  const { session } = Route.useRouteContext();
  if (!session) return null;
  const accessScope = calendarScope(session);
  return (
    <div className="view-waitlist">
      <PageHeading title={t("waitlist.title")} lead={t("waitlist.lead")} />
      <WaitlistView
        key={accessScope}
        mode="admin"
        viewer={{ userId: session.user.id, accessScope }}
        role={session.user.role}
        accessPreset={session.accessPreset}
        ownStaffId={session.staffId}
      />
    </div>
  );
}
