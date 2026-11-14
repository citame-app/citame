import { Popover } from "@base-ui/react/popover";
import type { CalendarAppointment, UserRole } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyboardIcon,
  PlusIcon,
  RefreshIcon,
} from "~/components/ui/icons";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, calendarQuery } from "~/lib/admin-queries";
import {
  dayOfMonth,
  formatDateLong,
  formatTime,
  localDateOf,
  monthShort,
  weekdayShort,
} from "~/lib/format";
import { salonQuery } from "~/lib/queries";
import { zonedInstant } from "~/lib/zoned";
import { useNow } from "../use-now";
import { AppointmentDrawer } from "./appointment-drawer";
import { CalendarGrid, type GridColumn } from "./calendar-grid";
import { shortcutFor } from "./keys";
import {
  availableActions,
  rangeFor,
  statusAppearance,
  type CalendarView as ViewName,
} from "./logic";
import { type NewAppointmentInitial, NewAppointmentSheet } from "./new-appointment";
import { type CalendarSearch, shiftDate } from "./search";
import { ShortcutsHelp } from "./shortcuts-help";
import { STATUS_CLASSES } from "./status-badge";
import { useMoveAppointment } from "./use-move";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable;
}

export function CalendarView({
  search,
  onSearchChange,
  role,
  ownStaffId,
  now: fixedNow,
}: {
  search: CalendarSearch;
  onSearchChange: (search: CalendarSearch) => void;
  role: UserRole;
  ownStaffId: string | null;
  now?: Date;
}) {
  const { t, locale, timeZone } = useI18n();
  const ticking = useNow(30_000);
  const now = fixedNow ?? ticking;
  const queryClient = useQueryClient();
  const salon = useQuery(salonQuery);
  const allStaff = useQuery(adminStaffQuery);
  const granularity = salon.data?.slotGranularityMinutes ?? 15;
  const range = rangeFor(search.view, search.date, timeZone);
  const selectedIds = search.staff ? search.staff.split(",") : [];
  const apiStaffIds = role === "owner" && selectedIds.length > 0 ? selectedIds : undefined;
  const query = useQuery(calendarQuery({ from: range.from, to: range.to, staffIds: apiStaffIds }));
  const { move, conflict, clearConflict } = useMoveAppointment();

  const [showCancelled, setShowCancelled] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<NewAppointmentInitial | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const calendar = query.data;
  const staffName = useCallback(
    (id: string) => calendar?.staff.find((s) => s.id === id)?.displayName ?? "",
    [calendar],
  );

  // The week view shows one team member's seven days: pick one when switching.
  const weekStaffId = selectedIds[0] ?? ownStaffId ?? calendar?.staff[0]?.id;
  const columns: GridColumn[] = useMemo(() => {
    if (!calendar) return [];
    if (search.view === "day") {
      return calendar.staff.map((s) => ({
        key: s.id,
        staffId: s.id,
        date: search.date,
        title: s.displayName,
      }));
    }
    const member = calendar.staff.find((s) => s.id === weekStaffId) ?? calendar.staff[0];
    if (!member) return [];
    return range.dates.map((date) => ({
      key: `${member.id}-${date}`,
      staffId: member.id,
      date,
      title: weekdayShort(date, locale),
      subtitle: `${dayOfMonth(date)} ${monthShort(date, locale)}`,
    }));
  }, [calendar, search.view, search.date, range.dates, locale, weekStaffId]);

  const openAppointment = calendar?.appointments.find((a) => a.id === openId) ?? null;
  const canMove = useCallback(
    (a: CalendarAppointment) => availableActions(role, a, now, ownStaffId).reschedule,
    [role, now, ownStaffId],
  );

  const go = useCallback(
    (patch: Partial<CalendarSearch>) => onSearchChange({ ...search, ...patch }),
    [search, onSearchChange],
  );
  const setView = (view: ViewName) =>
    onSearchChange({
      ...search,
      view,
      ...(view === "week" && weekStaffId ? { staff: weekStaffId } : {}),
    });
  const today = localDateOf(now.toISOString(), timeZone);
  const openNew = useCallback(
    (slot?: Partial<NewAppointmentInitial>) =>
      setCreating({
        staffId: slot?.staffId ?? (role === "staff" ? (ownStaffId ?? undefined) : weekStaffId),
        date: slot?.date ?? search.date,
        minutesOfDay: slot?.minutesOfDay,
      }),
    [role, ownStaffId, weekStaffId, search.date],
  );

  const handlers = useRef({
    go,
    setView,
    openNew,
    search,
    today,
    refetch: () => void query.refetch(),
  });
  handlers.current = { go, setView, openNew, search, today, refetch: () => void query.refetch() };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const dialogOpen = document.querySelector("[role='dialog']") !== null;
      const action = shortcutFor({
        key: event.key,
        typing: isTyping(event.target) || dialogOpen,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
      });
      if (!action) return;
      const h = handlers.current;
      event.preventDefault();
      switch (action) {
        case "today":
          h.go({ date: h.today });
          break;
        case "previous":
          h.go({ date: shiftDate(h.search.date, h.search.view, -1) });
          break;
        case "next":
          h.go({ date: shiftDate(h.search.date, h.search.view, 1) });
          break;
        case "day":
          h.setView("day");
          break;
        case "week":
          h.setView("week");
          break;
        case "new":
          h.openNew();
          break;
        case "refresh":
          h.refetch();
          break;
        case "help":
          setHelpOpen(true);
          break;
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const unit = t(search.view === "day" ? "calendar.unit.day" : "calendar.unit.week");
  const title =
    search.view === "day"
      ? formatDateLong(search.date, locale)
      : `${formatDateLong(range.dates[0] as string, locale)} - ${formatDateLong(range.dates[6] as string, locale)}`;
  const updated = query.dataUpdatedAt
    ? formatTime(new Date(query.dataUpdatedAt).toISOString(), timeZone, locale)
    : null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="secondary"
            aria-label={t("calendar.nav.previous", { unit })}
            onClick={() => go({ date: shiftDate(search.date, search.view, -1) })}
          >
            <ChevronLeftIcon />
          </Button>
          <Button variant="secondary" onClick={() => go({ date: today })}>
            {t("calendar.nav.today")}
          </Button>
          <Button
            variant="secondary"
            aria-label={t("calendar.nav.next", { unit })}
            onClick={() => go({ date: shiftDate(search.date, search.view, 1) })}
          >
            <ChevronRightIcon />
          </Button>
        </div>
        <h2
          className="mx-1 min-w-0 flex-1 font-display text-lg font-semibold sm:text-xl"
          aria-live="polite"
        >
          {title}
        </h2>
        <fieldset className="inline-flex rounded-md border border-line p-0.5">
          <legend className="sr-only">{t("calendar.view.label")}</legend>
          {(["day", "week"] as const).map((view) => (
            <span key={view} className="relative">
              <input
                type="radio"
                name="calendar-view"
                aria-label={t(`calendar.view.${view}`)}
                className="peer absolute inset-0 z-10 m-0 size-full cursor-pointer opacity-0"
                checked={search.view === view}
                onChange={() => setView(view)}
              />
              <span className="flex min-h-11 min-w-16 items-center justify-center rounded px-3 text-sm font-medium text-muted peer-checked:bg-accent peer-checked:text-accent-fg peer-focus-visible:outline-3 peer-focus-visible:outline-ring">
                {t(`calendar.view.${view}`)}
              </span>
            </span>
          ))}
        </fieldset>
        {role === "owner" && (
          <StaffFilter
            staff={(allStaff.data ?? []).filter((s) => s.active)}
            selected={search.view === "week" ? [weekStaffId ?? ""] : selectedIds}
            single={search.view === "week"}
            onChange={(ids) => go({ staff: ids.length > 0 ? ids.join(",") : undefined })}
          />
        )}
        <Button onClick={() => openNew()}>
          <PlusIcon />
          {t("calendar.newAppointment")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <label className="flex min-h-11 cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            className="size-5 accent-[var(--accent)]"
            checked={showCancelled}
            onChange={(e) => setShowCancelled(e.target.checked)}
          />
          {t("calendar.showCancelled")}
        </label>
        <div className="flex items-center gap-1">
          {updated && <span>{t("calendar.updatedAt", { time: updated })}</span>}
          <Button
            variant="ghost"
            aria-label={t("calendar.refresh")}
            onClick={() => void query.refetch()}
            loading={query.isFetching && !query.isPending}
          >
            {!(query.isFetching && !query.isPending) && <RefreshIcon />}
          </Button>
          <Button
            variant="ghost"
            aria-label={t("shortcuts.open")}
            onClick={() => setHelpOpen(true)}
          >
            <KeyboardIcon />
          </Button>
        </div>
      </div>

      {conflict && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-danger-fg/40 bg-danger-soft p-4 text-danger-fg"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium">{t("calendar.conflict.title")}</p>
            <p className="text-sm">{t(conflict.problem.messageKey)}</p>
          </div>
          <Button
            variant="secondary"
            onClick={() => {
              setOpenId(conflict.appointmentId);
              clearConflict();
            }}
          >
            {t("calendar.conflict.open")}
          </Button>
          <Button variant="ghost" onClick={clearConflict}>
            {t("calendar.conflict.dismiss")}
          </Button>
        </div>
      )}

      {query.isPending ? (
        <div role="status" aria-label={t("admin.loading")} className="space-y-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-[28rem]" />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : calendar && columns.length === 0 ? (
        <EmptyState title={t("calendar.grid.empty")} />
      ) : calendar ? (
        <CalendarGrid
          columns={columns}
          appointments={calendar.appointments}
          timeOff={calendar.timeOff}
          workingWindows={calendar.workingWindows}
          timeZone={timeZone}
          now={now}
          granularity={granularity}
          showCancelled={showCancelled}
          canMove={canMove}
          highlightId={conflict?.appointmentId ?? null}
          onSlotClick={(slot) => openNew(slot)}
          onOpenAppointment={(a) => setOpenId(a.id)}
          onMove={(appointment, to) => move({ appointment, to })}
        />
      ) : null}

      <Legend />

      <AppointmentDrawer
        appointment={openAppointment}
        staffName={openAppointment ? staffName(openAppointment.staffId) : ""}
        onClose={() => setOpenId(null)}
        role={role}
        ownStaffId={ownStaffId}
        now={now}
        onReload={() => void queryClient.invalidateQueries({ queryKey: ["admin"] })}
      />
      {creating && (
        <NewAppointmentSheet
          open
          onOpenChange={(open) => !open && setCreating(null)}
          initial={creating}
          role={role}
          ownStaffId={ownStaffId}
        />
      )}
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

function StaffFilter({
  staff,
  selected,
  single,
  onChange,
}: {
  staff: { id: string; displayName: string }[];
  selected: string[];
  single: boolean;
  onChange: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button variant="secondary" />}>
        {single ? t("calendar.staffFilter.week") : t("calendar.staffFilter")}
        {!single && selected.length > 0 && (
          <span className="rounded-full bg-accent px-2 text-xs text-accent-fg">
            {selected.length}
          </span>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup className="min-w-56 rounded-lg border border-line bg-surface p-2 shadow-lg">
            <fieldset className="m-0 border-0 p-0">
              <legend className="sr-only">
                {single ? t("calendar.staffFilter.week") : t("calendar.staffFilter")}
              </legend>
              {!single && (
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-sunken">
                  <input
                    type="radio"
                    name="staff-all"
                    className="size-5 accent-[var(--accent)]"
                    checked={selected.length === 0}
                    onChange={() => onChange([])}
                  />
                  {t("calendar.staffFilter.all")}
                </label>
              )}
              {staff.map((member) => (
                <label
                  key={member.id}
                  className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-sunken"
                >
                  <input
                    type={single ? "radio" : "checkbox"}
                    name="staff-filter"
                    className="size-5 accent-[var(--accent)]"
                    checked={selected.includes(member.id)}
                    onChange={(e) =>
                      single
                        ? onChange([member.id])
                        : onChange(
                            e.target.checked
                              ? [...selected, member.id]
                              : selected.filter((id) => id !== member.id),
                          )
                    }
                  />
                  {member.displayName}
                </label>
              ))}
            </fieldset>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Legend() {
  const { t } = useI18n();
  return (
    <section
      aria-label={t("calendar.legend")}
      className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-muted"
    >
      {(["booked", "completed", "no_show", "cancelled"] as const).map((status) => (
        <span
          key={status}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${STATUS_CLASSES[status]}`}
        >
          {t(statusAppearance(status).labelKey)}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="size-4 rounded border border-line bg-surface" />
        {t("calendar.legend.working")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-4 rounded border border-line bg-sunken" />
        {t("calendar.legend.off")}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="size-4 rounded border border-line-strong bg-[repeating-linear-gradient(135deg,var(--surface-sunken)_0_3px,var(--border)_3px_5px)]" />
        {t("calendar.legend.timeOff")}
      </span>
    </section>
  );
}

export { zonedInstant };
