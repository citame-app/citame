import { Popover } from "@base-ui/react/popover";
import type { CalendarAppointment, ScheduleConflict, UserRole } from "@sob/contracts";
import { permissionsFor } from "@sob/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/ui/button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  KeyboardIcon,
  MenuIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from "~/components/ui/icons";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { adminStaffQuery, calendarQuery } from "~/lib/admin-queries";
import { addDaysLocal, formatDateLong, formatTime, localDateOf } from "~/lib/format";
import { salonQuery } from "~/lib/queries";
import { zonedInstant } from "~/lib/zoned";
import { ConflictList } from "../staff/conflict-list";
import { useNow } from "../use-now";
import { AppointmentDrawer } from "./appointment-drawer";
import { BooksyContextImport } from "./booksy-context-import";
import { CalendarGrid, type GridColumn, type MoveRequest } from "./calendar-grid";
import { CalendarInbox } from "./inbox";
import { shortcutFor } from "./keys";
import { useCalendarLive } from "./live-provider";
import {
  availableActions,
  calendarViews,
  rangeFor,
  statusAppearance,
  type CalendarView as ViewName,
} from "./logic";
import { MiniCalendar } from "./mini-calendar";
import { type NewAppointmentInitial, NewAppointmentSheet } from "./new-appointment";
import { CalendarOverview } from "./overview";
import { indexCalendar, personInitials, serviceHue } from "./presentation";
import { ResourceCalendar } from "./resource-calendar";
import { type CalendarSearch, shiftDate } from "./search";
import { ShortcutsHelp } from "./shortcuts-help";
import { CalendarTimeOff } from "./time-off";
import { useMoveAppointment } from "./use-move";
import { CalendarWaitlist } from "./waitlist";

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el?.tagName && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)
  );
}

export function CalendarView({
  search,
  userId = "operator",
  accessScope,
  onSearchChange,
  role,
  bookingRole = role,
  ownStaffId,
  accessPreset,
  readOnly: providedReadOnly = false,
  now: fixedNow,
}: {
  search: CalendarSearch;
  userId?: string;
  accessScope?: string;
  onSearchChange: (search: CalendarSearch) => void;
  role: UserRole;
  bookingRole?: UserRole;
  ownStaffId: string | null;
  accessPreset?: import("@sob/contracts").StaffAccessPreset | null;
  readOnly?: boolean;
  now?: Date;
}) {
  const { t, locale, timeZone } = useI18n();
  const live = useCalendarLive();
  const ticking = useNow(30_000);
  const now = fixedNow ?? ticking;
  const today = localDateOf(now.toISOString(), timeZone);
  const queryClient = useQueryClient();
  const salon = useQuery(salonQuery);
  const allStaff = useQuery(adminStaffQuery);
  const selectedIds = useMemo(() => search.staff?.split(",") ?? [], [search.staff]);
  const resourceMode = search.view === "resources";
  const apiStaffIds =
    role === "owner" && !resourceMode && selectedIds.length > 0 ? selectedIds : undefined;
  const resourceOccupancy = resourceMode && role === "owner" ? "1" : undefined;
  const range = useMemo(
    () => rangeFor(search.view, search.date, timeZone),
    [search.view, search.date, timeZone],
  );
  const query = useQuery({
    ...calendarQuery({
      from: range.from,
      to: range.to,
      staffIds: apiStaffIds,
      accessScope,
      resourceOccupancy,
    }),
    ...(live ? { refetchInterval: false } : {}),
  });
  const calendar = query.data;
  const [lastConsultation, setLastConsultation] = useState(Boolean(calendar?.importSnapshot));
  const consultation = calendar ? Boolean(calendar.importSnapshot) : lastConsultation;
  useEffect(() => {
    if (calendar) setLastConsultation(Boolean(calendar.importSnapshot));
  }, [calendar]);
  const readOnly = providedReadOnly || consultation;
  const views =
    role === "owner" && !consultation
      ? calendarViews
      : calendarViews.filter((view) => view !== "resources");
  const { move, conflict, clearConflict } = useMoveAppointment();
  const [showCancelled, setShowCancelled] = useState(false);
  const [status, setStatus] = useState("all");
  const [resource, setResource] = useState<{ id: string; name: string } | null>(null);
  const [text, setText] = useState("");
  const deferredText = useDeferredValue(text);
  const [openId, setOpenId] = useState<string | null>(search.appointment ?? null);
  useEffect(() => setOpenId(search.appointment ?? null), [search.appointment]);
  const [creating, setCreating] = useState<NewAppointmentInitial | null>(null);
  const [adding, setAdding] = useState(false);
  const [blocking, setBlocking] = useState<"time" | "absence" | null>(null);
  const [timeOffConflicts, setTimeOffConflicts] = useState<ScheduleConflict[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const granularity = salon.data?.slotGranularityMinutes ?? 15;
  const permissions = permissionsFor(bookingRole, accessPreset);
  const timeOffStaff = (allStaff.data ?? []).filter(
    (member) => member.active && (permissions.editSchedules || member.id === ownStaffId),
  );

  const staff = useMemo(
    () =>
      (calendar?.staff ?? []).filter((member) => {
        if (selectedIds.length && !selectedIds.includes(member.id)) return false;
        if (!search.working) return true;
        return calendar?.workingWindows.some(
          (window) =>
            window.staffId === member.id &&
            window.startsAt < range.to &&
            window.endsAt > range.from,
        );
      }),
    [calendar?.staff, calendar?.workingWindows, search.working, selectedIds, range.from, range.to],
  );
  const staffIds = useMemo(() => new Set(staff.map((member) => member.id)), [staff]);
  const resourceOptions = useMemo(() => {
    const names = new Map<string, string>();
    if (resource) names.set(resource.id, resource.name);
    for (const appointment of calendar?.appointments ?? []) {
      if (!staffIds.has(appointment.staffId)) continue;
      for (const booked of appointment.resources ?? []) {
        if (booked.resourceId) names.set(booked.resourceId, booked.name);
      }
    }
    const counts = new Map<string, number>();
    for (const name of names.values()) counts.set(name, (counts.get(name) ?? 0) + 1);
    const ordinals = new Map<string, number>();
    return [...names]
      .sort(
        ([idA, nameA], [idB, nameB]) =>
          nameA.localeCompare(nameB, locale) || idA.localeCompare(idB),
      )
      .map(([id, name]) => {
        const ordinal = (ordinals.get(name) ?? 0) + 1;
        ordinals.set(name, ordinal);
        return { id, name, label: (counts.get(name) ?? 0) > 1 ? `${name} · ${ordinal}` : name };
      });
  }, [calendar?.appointments, locale, resource, staffIds]);
  const appointments = useMemo(() => {
    const needle = deferredText.trim().toLocaleLowerCase(locale);
    return (calendar?.appointments ?? []).filter(
      (a) =>
        staffIds.has(a.staffId) &&
        (showCancelled || a.status !== "cancelled") &&
        (status === "all" || a.status === status) &&
        (!resource || a.resources?.some((booked) => booked.resourceId === resource.id)) &&
        (!needle ||
          `${a.clientName} ${a.serviceNames.join(" ")}`.toLocaleLowerCase(locale).includes(needle)),
    );
  }, [calendar?.appointments, showCancelled, status, resource, deferredText, locale, staffIds]);
  const isDay = search.view === "day";
  const index = useMemo(
    () => (isDay || resourceMode ? null : indexCalendar(appointments, timeZone)),
    [isDay, resourceMode, appointments, timeZone],
  );
  const serviceNames = useMemo(
    () =>
      [...new Set((calendar?.appointments ?? []).flatMap((a) => a.serviceNames))].sort((a, b) =>
        a.localeCompare(b, locale),
      ),
    [calendar?.appointments, locale],
  );
  const columns: GridColumn[] = useMemo(
    () =>
      staff.map((member) => ({
        key: member.id,
        staffId: member.id,
        date: search.date,
        title: member.displayName,
        subtitle: (calendar?.workingWindows ?? [])
          .filter(
            (window) =>
              window.staffId === member.id &&
              localDateOf(window.startsAt, timeZone) === search.date,
          )
          .map(
            (window) =>
              `${formatTime(window.startsAt, timeZone, locale)}–${formatTime(window.endsAt, timeZone, locale)}`,
          )
          .join(", "),
      })),
    [staff, search.date, calendar?.workingWindows, timeZone, locale],
  );
  const openAppointment = calendar?.appointments.find((a) => a.id === openId) ?? null;
  const onOpenAppointment = useCallback((appointment: CalendarAppointment) => {
    setOpenId(appointment.id);
  }, []);
  const onMoveAppointment = useCallback(
    (appointment: CalendarAppointment, to: MoveRequest) => {
      move({ appointment, to });
    },
    [move],
  );
  const canMove = useCallback(
    (a: CalendarAppointment) => availableActions(role, a, now, ownStaffId, !readOnly).reschedule,
    [role, now, ownStaffId, readOnly],
  );
  const go = useCallback(
    (patch: Partial<CalendarSearch>) => onSearchChange({ ...search, ...patch }),
    [search, onSearchChange],
  );
  useEffect(() => {
    if (consultation && resourceMode) go({ view: "day" });
  }, [consultation, go, resourceMode]);
  const setView = (view: ViewName) => go({ view });
  const openNew = useCallback(
    (slot?: Partial<NewAppointmentInitial>) => {
      if (!readOnly && calendar)
        setCreating({
          staffId:
            slot?.staffId ??
            (role === "staff" ? (ownStaffId ?? undefined) : (selectedIds[0] ?? staff[0]?.id)),
          date: slot?.date ?? search.date,
          minutesOfDay: slot?.minutesOfDay,
        });
    },
    [readOnly, calendar, role, ownStaffId, selectedIds, staff, search.date],
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
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        event.target instanceof Element &&
        event.target.closest(".calendar-resource-scroll")
      )
        return;
      const action = shortcutFor({
        key: event.key,
        typing: isTyping(event.target) || document.querySelector("[role='dialog']") !== null,
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
        case "month":
          h.setView("month");
          break;
        case "list":
          h.setView("list");
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

  // Prefetch only on intent. Never label old-range appointments with the newly selected date.
  const prefetch = (direction: 1 | -1) => {
    const next = rangeFor(search.view, shiftDate(search.date, search.view, direction), timeZone);
    void queryClient.prefetchQuery(
      calendarQuery({
        from: next.from,
        to: next.to,
        staffIds: apiStaffIds,
        accessScope,
        resourceOccupancy,
      }),
    );
  };
  const onDay = (date: string, staffId?: string) =>
    go({ view: "day", date, ...(staffId ? { staff: staffId, working: undefined } : {}) });
  const unit = t(
    search.view === "month"
      ? "calendar.unit.month"
      : isDay || resourceMode
        ? "calendar.unit.day"
        : "calendar.unit.week",
  );
  const title =
    search.view === "month"
      ? new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(
          new Date(`${search.date}T12:00:00Z`),
        )
      : isDay || resourceMode
        ? formatDateLong(search.date, locale)
        : `${formatDateLong(range.dates[0] as string, locale)} – ${formatDateLong(range.dates.at(-1) as string, locale)}`;

  return (
    <div className="calendar-workbench" data-sidebar-collapsed={sidebarCollapsed || undefined}>
      {consultation && (
        <p role="status" className="border-b border-line bg-sunken px-5 py-3 text-sm text-muted">
          {t("badge.consultation")}
        </p>
      )}
      <header className="calendar-page-header">
        <div className="calendar-page-heading">
          <button
            type="button"
            className="calendar-icon-button calendar-toggle-desktop"
            aria-label={t("calendar.toggleSidebar")}
            aria-expanded={!sidebarCollapsed}
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          >
            <MenuIcon />
          </button>
          <button
            type="button"
            className="calendar-icon-button calendar-toggle-mobile"
            aria-label={t("calendar.filters")}
            aria-expanded={filtersOpen}
            aria-controls="calendar-filters"
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <MenuIcon />
          </button>
          <div>
            <h1>{t("calendar.title")}</h1>
            <p>{t("calendar.workspaceLead")}</p>
          </div>
        </div>
        <div className="calendar-toolbar-actions">
          <CalendarInbox
            userId={userId}
            rewardAccess={permissions.commerce && permissions.clients}
          />
          {live !== undefined && (
            <span
              className="calendar-live-state"
              role="img"
              data-live={live || undefined}
              title={t(live ? "calendar.live.connected" : "calendar.live.reconnecting")}
              aria-label={t(live ? "calendar.live.connected" : "calendar.live.reconnecting")}
            >
              <i aria-hidden="true" />
            </span>
          )}
          {resourceMode && query.dataUpdatedAt > 0 && (
            <p className="calendar-resource-updated">
              {t("calendar.updatedAt", {
                time: formatTime(new Date(query.dataUpdatedAt).toISOString(), timeZone, locale),
              })}
            </p>
          )}
          <label className="calendar-search" hidden={resourceMode}>
            <SearchIcon width={16} />
            <span className="sr-only">{t("calendar.search")}</span>
            <input
              type="search"
              placeholder={t("calendar.search")}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="calendar-icon-button"
            aria-label={t("calendar.refresh")}
            aria-busy={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshIcon className={query.isFetching ? "animate-spin" : undefined} />
          </button>
          <button
            type="button"
            className="calendar-icon-button calendar-shortcuts"
            aria-label={t("shortcuts.open")}
            onClick={() => setHelpOpen(true)}
          >
            <KeyboardIcon />
          </button>
          {!readOnly && (
            <Popover.Root open={adding} onOpenChange={setAdding}>
              <Popover.Trigger
                className="calendar-create calendar-primary-action"
                disabled={!calendar}
                aria-label={t("calendar.add")}
                title={t("calendar.add")}
              >
                <PlusIcon width={18} height={18} />
                <span>{t("calendar.add")}</span>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Positioner side="bottom" align="end" sideOffset={12} className="z-40">
                  <Popover.Popup className="calendar-add-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setAdding(false);
                        openNew();
                      }}
                    >
                      {t("calendar.newAppointment")}
                    </button>
                    {(permissions.editSchedules || ownStaffId) && (
                      <>
                        <button
                          type="button"
                          disabled={!timeOffStaff.length}
                          onClick={() => {
                            setAdding(false);
                            setBlocking("time");
                          }}
                        >
                          {t("calendar.blockTime")}
                        </button>
                        <button
                          type="button"
                          disabled={!timeOffStaff.length}
                          onClick={() => {
                            setAdding(false);
                            setBlocking("absence");
                          }}
                        >
                          {t("calendar.addAbsence")}
                        </button>
                      </>
                    )}
                  </Popover.Popup>
                </Popover.Positioner>
              </Popover.Portal>
            </Popover.Root>
          )}
        </div>
      </header>
      <div className="calendar-body">
        <aside
          id="calendar-filters"
          className="calendar-filters"
          data-mobile-open={filtersOpen || undefined}
        >
          <MiniCalendar
            headingLevel={2}
            date={search.date}
            today={today}
            onSelect={(date) => {
              go({ date });
              setFiltersOpen(false);
            }}
          />
          <details className="calendar-filter-section calendar-jump-options">
            <summary>{t("calendar.jumpWeeks")}</summary>
            {[1, -1].map((direction) => (
              <div key={direction} className="grid grid-cols-6 gap-1">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    type="button"
                    key={n}
                    className="calendar-week-jump"
                    aria-label={t("calendar.jumpByWeeks", { count: n * direction })}
                    onClick={() => go({ date: addDaysLocal(search.date, n * direction * 7) })}
                  >
                    {direction === 1 ? "+" : "−"}
                    {n}
                  </button>
                ))}
              </div>
            ))}
          </details>
          {!resourceMode && role === "owner" && (
            <details className="calendar-filter-section" open>
              <summary>{t("calendar.staffFilter")}</summary>
              <label className="calendar-filter-check">
                <input
                  type="checkbox"
                  checked={!!search.working}
                  onChange={(event) => go({ working: event.target.checked || undefined })}
                />
                {t("calendar.workingOnly")}
              </label>
              <label className="calendar-filter-check">
                <input
                  type="checkbox"
                  checked={selectedIds.length === 0}
                  onChange={() => go({ staff: undefined })}
                />
                {t("calendar.staffFilter.all")}
              </label>
              {(allStaff.data ?? calendar?.staff ?? [])
                .filter((member) => !("active" in member) || member.active)
                .map((member) => (
                  <label key={member.id} className="calendar-filter-check">
                    <input
                      type="checkbox"
                      checked={selectedIds.length === 0 || selectedIds.includes(member.id)}
                      onChange={(event) => {
                        const current = selectedIds.length
                          ? selectedIds
                          : (allStaff.data ?? calendar?.staff ?? [])
                              .filter((s) => !("active" in s) || s.active)
                              .map((s) => s.id);
                        const next = event.target.checked
                          ? [...new Set([...current, member.id])]
                          : current.filter((id) => id !== member.id);
                        // An empty API filter means everyone. Keep the last visible member selected.
                        if (next.length) go({ staff: next.join(",") });
                      }}
                    />
                    <span
                      className="calendar-filter-avatar"
                      aria-hidden="true"
                      style={{ "--person-hue": serviceHue(member.displayName) } as CSSProperties}
                    >
                      {personInitials(member.displayName)}
                    </span>
                    {member.displayName}
                  </label>
                ))}
            </details>
          )}
          {role === "owner" && !readOnly && <BooksyContextImport />}
          <section className="calendar-filter-section" hidden={resourceMode}>
            <h3>
              <label htmlFor="calendar-status">{t("calendar.statusFilter")}</label>
            </h3>
            <select
              id="calendar-status"
              aria-label={t("calendar.statusFilter")}
              className="calendar-filter-select"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
                if (event.target.value === "cancelled") setShowCancelled(true);
              }}
            >
              <option value="all">{t("calendar.allStatuses")}</option>
              {(["booked", "completed", "no_show", "cancelled"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(statusAppearance(value).labelKey)}
                </option>
              ))}
            </select>
            <label className="calendar-filter-check">
              <input
                type="checkbox"
                checked={showCancelled}
                onChange={(event) => {
                  setShowCancelled(event.target.checked);
                  if (!event.target.checked && status === "cancelled") setStatus("all");
                }}
              />
              {t("calendar.showCancelled")}
            </label>
            <button
              type="button"
              className="calendar-reset"
              onClick={() => {
                setStatus("all");
                setShowCancelled(false);
                setText("");
                setResource(null);
                go({ staff: undefined, working: undefined });
              }}
            >
              {t("calendar.clearFilters")}
            </button>
          </section>
          {!resourceMode && resourceOptions.length > 0 && (
            <section className="calendar-filter-section">
              <h3>
                <label htmlFor="calendar-resource">{t("calendar.resourceFilter")}</label>
              </h3>
              <select
                id="calendar-resource"
                className="calendar-filter-select"
                value={resource?.id ?? ""}
                onChange={(event) => {
                  setResource(
                    resourceOptions.find((option) => option.id === event.target.value) ?? null,
                  );
                }}
              >
                <option value="">{t("calendar.allResources")}</option>
                {resourceOptions.map(({ id, label }) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </section>
          )}
          {!resourceMode && serviceNames.length > 0 && (
            <section className="calendar-filter-section calendar-service-legend">
              <h3>{t("calendar.serviceColors")}</h3>
              <ul>
                {serviceNames.map((name) => (
                  <li key={name}>
                    <i
                      className="calendar-service-swatch"
                      aria-hidden="true"
                      style={{ "--service-hue": serviceHue(name) } as CSSProperties}
                    />
                    <span>{name}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {query.dataUpdatedAt > 0 && (
            <p className="calendar-updated">
              {t("calendar.updatedAt", {
                time: formatTime(new Date(query.dataUpdatedAt).toISOString(), timeZone, locale),
              })}
            </p>
          )}
        </aside>
        <div className="calendar-main" aria-busy={query.isPending}>
          <div className="calendar-toolbar">
            <div className="calendar-date-navigation">
              <button
                type="button"
                className="calendar-today-button"
                onClick={() => go({ date: today })}
              >
                {t("calendar.nav.today")}
              </button>
              <button
                type="button"
                className="calendar-icon-button"
                aria-label={t("calendar.nav.previous", { unit })}
                onPointerEnter={() => prefetch(-1)}
                onFocus={() => prefetch(-1)}
                onClick={() => go({ date: shiftDate(search.date, search.view, -1) })}
              >
                <ChevronLeftIcon />
              </button>
              <Popover.Root open={dateOpen} onOpenChange={setDateOpen}>
                <Popover.Trigger
                  className="calendar-date-title"
                  aria-label={`${title}. ${t("calendar.datePicker")}`}
                >
                  <h2 aria-live="polite">{title}</h2>
                </Popover.Trigger>
                <Popover.Portal>
                  <Popover.Positioner sideOffset={8} className="z-40">
                    <Popover.Popup className="w-64 rounded-lg border border-line bg-surface p-3 shadow-lg">
                      <MiniCalendar
                        date={search.date}
                        today={today}
                        onSelect={(date) => {
                          go({ date });
                          setDateOpen(false);
                        }}
                      />
                      <label className="mt-3 block text-xs text-muted">
                        {t("calendar.goToDate")}
                        <input
                          type="date"
                          className="mt-1 block w-full rounded border border-line bg-surface p-2 text-fg"
                          value={search.date}
                          onChange={(event) => {
                            if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) {
                              go({ date: event.target.value });
                              setDateOpen(false);
                            }
                          }}
                        />
                      </label>
                    </Popover.Popup>
                  </Popover.Positioner>
                </Popover.Portal>
              </Popover.Root>
              <button
                type="button"
                className="calendar-icon-button"
                aria-label={t("calendar.nav.next", { unit })}
                onPointerEnter={() => prefetch(1)}
                onFocus={() => prefetch(1)}
                onClick={() => go({ date: shiftDate(search.date, search.view, 1) })}
              >
                <ChevronRightIcon />
              </button>
            </div>
            <label className="sr-only" htmlFor="calendar-view">
              {t("calendar.view.label")}
            </label>
            <select
              id="calendar-view"
              className="calendar-view-select"
              value={search.view}
              onChange={(event) => setView(event.target.value as ViewName)}
            >
              {views.map((view) => (
                <option key={view} value={view}>
                  {t(`calendar.view.${view}`)}
                </option>
              ))}
            </select>
            <fieldset className="calendar-view-segments">
              <legend className="sr-only">{t("calendar.view.label")}</legend>
              {views.map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={search.view === view}
                  onClick={() => setView(view)}
                >
                  {t(`calendar.view.${view}`)}
                </button>
              ))}
            </fieldset>
            {permissions.clients && permissions.editCalendar && (
              <CalendarWaitlist
                fromDate={range.dates[0] ?? search.date}
                toDate={range.dates.at(-1) ?? search.date}
                role={bookingRole}
                ownStaffId={ownStaffId}
                accessPreset={accessPreset}
              />
            )}
          </div>
          {conflict && (
            <div role="alert" className="calendar-conflict">
              <div>
                <strong>{t("calendar.conflict.title")}</strong>
                <p>{t(conflict.problem.messageKey)}</p>
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
            <div
              role="status"
              aria-label={t("admin.loading")}
              className="flex min-h-0 flex-1 flex-col gap-2 p-4"
            >
              <Skeleton className="h-16 shrink-0" />
              <Skeleton className="min-h-0 flex-1" />
            </div>
          ) : query.isError ? (
            <ErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : calendar && resourceMode ? (
            <ResourceCalendar calendar={calendar} onOpen={onOpenAppointment} />
          ) : calendar && staff.length === 0 ? (
            <EmptyState title={t("calendar.grid.empty")} />
          ) : calendar && search.view === "day" ? (
            <CalendarGrid
              columns={columns}
              appointments={appointments}
              timeOff={calendar.timeOff}
              workingWindows={calendar.workingWindows}
              timeZone={timeZone}
              now={now}
              granularity={granularity}
              showCancelled={showCancelled}
              canMove={canMove}
              highlightId={conflict?.appointmentId ?? null}
              onSlotClick={openNew}
              onOpenAppointment={onOpenAppointment}
              onMove={onMoveAppointment}
            />
          ) : calendar && index ? (
            <CalendarOverview
              view={search.view as Exclude<ViewName, "day" | "resources">}
              dates={range.dates}
              date={search.date}
              today={today}
              staff={staff}
              index={index}
              timeOff={calendar.timeOff}
              workingWindows={calendar.workingWindows}
              timeZone={timeZone}
              onDay={onDay}
              onOpen={onOpenAppointment}
            />
          ) : null}
        </div>
      </div>
      <AppointmentDrawer
        appointment={openAppointment}
        staffName={
          calendar?.staff.find((s) => s.id === openAppointment?.staffId)?.displayName ?? ""
        }
        onClose={() => {
          setOpenId(null);
          if (search.appointment) go({ appointment: undefined });
        }}
        role={role}
        billingRole={bookingRole}
        readOnly={readOnly}
        ownStaffId={ownStaffId}
        now={now}
        onReload={() => void queryClient.invalidateQueries({ queryKey: ["admin"] })}
      />
      {creating && !readOnly && (
        <NewAppointmentSheet
          open
          onOpenChange={(open) => !open && setCreating(null)}
          initial={creating}
          role={bookingRole}
          ownStaffId={ownStaffId}
          accessPreset={accessPreset}
        />
      )}
      {blocking && !readOnly && (
        <CalendarTimeOff
          staff={timeOffStaff}
          date={search.date}
          initialStaffId={permissions.editSchedules ? selectedIds[0] : (ownStaffId ?? undefined)}
          absence={blocking === "absence"}
          onClose={() => setBlocking(null)}
          onConflicts={setTimeOffConflicts}
        />
      )}
      {timeOffConflicts.length > 0 && (
        <div className="calendar-timeoff-conflicts">
          <ConflictList conflicts={timeOffConflicts} />
          <Button variant="secondary" onClick={() => setTimeOffConflicts([])}>
            {t("common.dismiss")}
          </Button>
        </div>
      )}
      <ShortcutsHelp open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}
export { zonedInstant };
