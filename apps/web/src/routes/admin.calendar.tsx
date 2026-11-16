import { permissionsFor } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { PageHeading } from "~/components/pages";
import { CalendarView } from "~/features/admin/calendar/calendar-view";
import { type CalendarSearch, validateCalendarSearch } from "~/features/admin/calendar/search";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";
import { localDateOf } from "~/lib/format";

type RawSearch = Partial<CalendarSearch>;

export const Route = createFileRoute("/admin/calendar")({
  // The default date is "today in the salon timezone", which is only known with the salon: the
  // page fills it in, so an absent date stays absent in the URL.
  validateSearch: (raw: Record<string, unknown>): RawSearch => {
    const parsed = validateCalendarSearch(raw, "");
    return {
      view: parsed.view,
      ...(raw.date !== undefined && parsed.date !== "" ? { date: parsed.date } : {}),
      ...(parsed.staff ? { staff: parsed.staff } : {}),
    };
  },
  head: adminHead("calendar.title"),
  component: CalendarPage,
});

function CalendarPage() {
  const { t, timeZone } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!session) return null;
  const permissions = permissionsFor(session.user.role, session.accessPreset);
  const date = search.date ?? localDateOf(new Date().toISOString(), timeZone);
  return (
    <>
      <PageHeading title={t("calendar.title")} />
      <CalendarView
        search={{
          view: search.view ?? "day",
          date,
          ...(search.staff ? { staff: search.staff } : {}),
        }}
        onSearchChange={(next) => void navigate({ search: next, replace: true })}
        role={permissions.allCalendars ? "owner" : session.user.role}
        bookingRole={session.user.role}
        readOnly={!permissions.editCalendar}
        ownStaffId={session.staffId}
        accessPreset={session.accessPreset}
      />
    </>
  );
}
