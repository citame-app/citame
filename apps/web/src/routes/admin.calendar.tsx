import { permissionsFor } from "@sob/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertIcon } from "~/components/ui/icons";
import { CalendarView } from "~/features/admin/calendar/calendar-view";
import { rangeFor } from "~/features/admin/calendar/logic";
import { type CalendarSearch, validateCalendarSearch } from "~/features/admin/calendar/search";
import { adminHead } from "~/features/admin/route-head";
import { useI18n } from "~/i18n/react";
import { calendarQuery, calendarWaitlistQuery, staffQuery } from "~/lib/admin-queries";
import { localDateOf } from "~/lib/format";
import { routeEndpoints } from "~/server/request";

type RawSearch = Partial<CalendarSearch> & { notice?: "forbidden" };

export const Route = createFileRoute("/admin/calendar")({
  // The default date is "today in the salon timezone", which is only known with the salon: the
  // page fills it in, so an absent date stays absent in the URL.
  validateSearch: (raw: Record<string, unknown>): RawSearch => {
    const parsed = validateCalendarSearch(raw, "");
    return {
      view: parsed.view,
      // The router retains raw keys that a validator omits, including unsupported date aliases.
      date: parsed.date || undefined,
      ...(parsed.staff ? { staff: parsed.staff } : {}),
      ...(parsed.working ? { working: true } : {}),
      ...(parsed.appointment ? { appointment: parsed.appointment } : {}),
      ...(raw.notice === "forbidden" ? { notice: "forbidden" } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ date: search.date, view: search.view, staff: search.staff }),
  loader: async ({ context, deps, cause }) => {
    // The initial response and route preloads have real content before React paints. Changing
    // calendar filters in place still commits immediately and fetches the exact new range.
    if (cause === "stay" || !context.session) return;
    const { timezone } = context.salon;
    const date = deps.date ?? localDateOf(new Date().toISOString(), timezone);
    const { from, to, dates } = rangeFor(deps.view ?? "day", date, timezone);
    const { user, accessPreset } = context.session;
    const permissions = permissionsFor(user.role, accessPreset);
    const staffIds = permissions.allCalendars ? deps.staff?.split(",") : undefined;
    const accessScope = calendarScope(context.session);
    await Promise.allSettled([
      context.queryClient.ensureQueryData(
        calendarQuery({ from, to, staffIds, accessScope }, routeEndpoints),
      ),
      context.queryClient.ensureQueryData(staffQuery(routeEndpoints)),
      ...(permissions.clients && permissions.editCalendar
        ? [
            context.queryClient.prefetchQuery(
              calendarWaitlistQuery(
                { fromDate: dates[0] ?? date, toDate: dates.at(-1) ?? date },
                routeEndpoints,
              ),
            ),
          ]
        : []),
    ]);
  },
  head: adminHead("calendar.title"),
  component: CalendarPage,
});

function calendarScope(session: NonNullable<ReturnType<typeof Route.useRouteContext>["session"]>) {
  return JSON.stringify([
    session.user.id,
    session.user.role,
    session.accessPreset,
    session.staffId,
  ]);
}

function CalendarPage() {
  const { t, timeZone } = useI18n();
  const { session } = Route.useRouteContext();
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  if (!session) return null;
  const permissions = permissionsFor(session.user.role, session.accessPreset);
  const accessScope = calendarScope(session);
  const date = search.date ?? localDateOf(new Date().toISOString(), timeZone);
  return (
    <>
      {search.notice === "forbidden" && (
        <p
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-warning-fg/40 bg-warning-soft p-4 text-warning-fg"
        >
          <AlertIcon className="mt-0.5 shrink-0" />
          {t("admin.notice.forbidden")}
        </p>
      )}
      <CalendarView
        key={accessScope}
        accessScope={accessScope}
        userId={session.user.id}
        search={{
          view: search.view ?? "day",
          date,
          ...(search.staff ? { staff: search.staff } : {}),
          ...(search.working ? { working: true } : {}),
          ...(search.appointment ? { appointment: search.appointment } : {}),
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
