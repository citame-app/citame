import { createFileRoute } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { AlertIcon } from "~/components/ui/icons";
import { TodayView } from "~/features/admin/today/today-view";
import { useI18n } from "~/i18n/react";
import { formatDateLong, localDateOf } from "~/lib/format";

export const Route = createFileRoute("/admin/")({
  validateSearch: (search: Record<string, unknown>): { notice?: "forbidden" } =>
    search.notice === "forbidden" ? { notice: "forbidden" } : {},
  component: AdminHome,
});

function AdminHome() {
  const { t, locale, timeZone } = useI18n();
  const { session } = Route.useRouteContext();
  const { notice } = Route.useSearch();
  if (!session) return null;
  const today = formatDateLong(localDateOf(new Date().toISOString(), timeZone), locale);
  return (
    <>
      <PageHeading
        title={t("today.title")}
        lead={`${today} · ${t("admin.welcome", { name: session.user.name })}`}
      />
      {notice === "forbidden" && (
        <p
          role="alert"
          className="mb-6 flex items-start gap-3 rounded-lg border border-warning-fg/40 bg-warning-soft p-4 text-warning-fg"
        >
          <AlertIcon className="mt-0.5 shrink-0" />
          {t("admin.notice.forbidden")}
        </p>
      )}
      <TodayView role={session.user.role} ownStaffId={session.staffId} />
    </>
  );
}
