import type { CalendarAppointment, TimeOff, WorkingWindow } from "@sob/contracts";
import {
  type CSSProperties,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertIcon, CheckIcon, ClockIcon, SlashIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { formatTime, localDateOf } from "~/lib/format";
import { processingRanges } from "~/lib/processing";
import { zonedInstant } from "~/lib/zoned";
import { AppointmentBadges } from "./appointment-badges";
import type { MoveRequest } from "./appointment-writes";
import { type ColumnRect, dropTarget, exceedsDragThreshold } from "./drag";
import { keyboardMove } from "./keys";
import {
  gridHours,
  layoutBlocks,
  nowMarkerMinutes,
  offsetToSnappedMinutes,
  statusAppearance,
} from "./logic";
import {
  type CalendarEntry,
  indexCalendar,
  localMinuteRange,
  personInitials,
  serviceHue,
  staffByDay,
} from "./presentation";

/** Pixels per minute: 30 minutes is ~48px, tall enough to read and to tap. */
export const PX_PER_MINUTE = 1.6;
const MIN_BLOCK_PX = 24;
const ICONS = { clock: ClockIcon, check: CheckIcon, slash: SlashIcon, alert: AlertIcon };

export interface GridColumn {
  key: string;
  staffId: string;
  date: string;
  title: string;
  subtitle?: string;
}

export interface SlotRequest {
  staffId: string;
  date: string;
  minutesOfDay: number;
}

export interface CalendarGridProps {
  columns: GridColumn[];
  appointments: CalendarAppointment[];
  timeOff: TimeOff[];
  workingWindows: WorkingWindow[];
  timeZone: string;
  now: Date;
  granularity: number;
  showCancelled: boolean;
  canMove: (appointment: CalendarAppointment) => boolean;
  onSlotClick: (slot: SlotRequest) => void;
  onOpenAppointment: (appointment: CalendarAppointment) => void;
  onMove: (appointment: CalendarAppointment, to: MoveRequest) => void;
  /** Appointment currently highlighted (for example the one a failed move belongs to). */
  highlightId?: string | null;
}

interface DragState {
  id: string;
  pointerId: number;
  start: { x: number; y: number };
  grabOffsetY: number;
  dx: number;
  dy: number;
  active: boolean;
}

export const CalendarGrid = memo(function CalendarGrid(props: CalendarGridProps) {
  const {
    columns,
    appointments,
    timeOff,
    workingWindows,
    timeZone,
    now,
    granularity,
    showCancelled,
  } = props;
  const { t, locale } = useI18n();
  const visible = useMemo(
    () => appointments.filter((a) => showCancelled || a.status !== "cancelled"),
    [appointments, showCancelled],
  );
  const { startHour, endHour } = useMemo(
    () => gridHours(workingWindows, visible, timeZone),
    [workingWindows, visible, timeZone],
  );
  const gridStart = startHour * 60;
  const height = (endHour - startHour) * 60 * PX_PER_MINUTE;
  const viewport = useRef<HTMLElement | null>(null);
  const positionedFor = useRef("");
  const surfaces = useRef(new Map<string, HTMLElement>());
  useEffect(() => {
    const identity = columns.map((column) => `${column.staffId}:${column.date}`).join(",");
    if (!viewport.current || positionedFor.current === identity) return;
    positionedFor.current = identity;
    const starts = columns.flatMap((column) =>
      [
        ...workingWindows.filter((w) => w.staffId === column.staffId),
        ...visible.filter((a) => a.staffId === column.staffId),
      ].flatMap((item) => {
        const range = localMinuteRange(item, column.date, timeZone);
        return range ? [range.start] : [];
      }),
    );
    if (starts.length)
      viewport.current.scrollTop = Math.max(
        0,
        (Math.floor(Math.min(...starts) / 60) * 60 - gridStart) * PX_PER_MINUTE - 12,
      );
  }, [columns, workingWindows, visible, gridStart, timeZone]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const dragNode = useRef<HTMLElement | null>(null);
  const dragFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    },
    [],
  );
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);
  const staffOrder = useMemo(() => [...new Set(columns.map((c) => c.staffId))], [columns]);
  const today = localDateOf(now.toISOString(), timeZone);
  const firstTodayColumn = columns.find((c) => c.date === today)?.key;

  const columnRects = (): ColumnRect[] =>
    columns.flatMap((column) => {
      const el = surfaces.current.get(column.key);
      if (!el) return [];
      const r = el.getBoundingClientRect();
      return [
        {
          staffId: column.staffId,
          date: column.date,
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        },
      ];
    });

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, entry: CalendarEntry) {
    const appointment = entry.appointment;
    if (event.pointerType === "touch" || event.button !== 0 || !props.canMove(appointment)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.closest<HTMLElement>("[data-block]")?.getBoundingClientRect();
    dragNode.current = event.currentTarget.closest<HTMLElement>("[data-block]");
    const next: DragState = {
      id: entry.id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      grabOffsetY: (rect ? event.clientY - rect.top : 0) + entry.offsetMinutes * PX_PER_MINUTE,
      dx: 0,
      dy: 0,
      active: false,
    };
    dragRef.current = next;
    setDrag(next);
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    const current = dragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const next = { x: event.clientX, y: event.clientY };
    const active = current.active || exceedsDragThreshold(current.start, next);
    const updated = {
      ...current,
      dx: next.x - current.start.x,
      dy: next.y - current.start.y,
      active,
    };
    dragRef.current = updated;
    if (active && !current.active) setDrag(updated);
    // Animate only the dragged element; don't reconcile the entire calendar per pointer event.
    if (active && dragFrame.current === null)
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null;
        const latest = dragRef.current;
        if (dragNode.current && latest?.active)
          dragNode.current.style.transform = `translate(${latest.dx}px, ${latest.dy}px)`;
      });
  }

  function resetDrag() {
    if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current);
    dragFrame.current = null;
    if (dragNode.current) dragNode.current.style.transform = "";
    dragNode.current = null;
    dragRef.current = null;
    setDrag(null);
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>, appointment: CalendarAppointment) {
    const finished = dragRef.current;
    if (!finished || finished.pointerId !== event.pointerId) return;
    resetDrag();
    if (!finished.active) return;
    suppressClick.current = true;
    const target = dropTarget(
      { x: event.clientX, y: event.clientY },
      finished.grabOffsetY,
      columnRects(),
      {
        startHour,
        pxPerMinute: PX_PER_MINUTE,
        granularity,
      },
    );
    if (!target) return;
    const h = String(Math.floor(target.minutesOfDay / 60)).padStart(2, "0");
    const m = String(target.minutesOfDay % 60).padStart(2, "0");
    const startsAt = zonedInstant(target.date, `${h}:${m}`, timeZone);
    if (startsAt !== appointment.startsAt || target.staffId !== appointment.staffId) {
      props.onMove(appointment, { staffId: target.staffId, startsAt });
    }
  }

  function onBlockKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    appointment: CalendarAppointment,
  ) {
    if (!props.canMove(appointment)) return;
    const move = keyboardMove({
      key: event.key,
      altKey: event.altKey,
      startsAt: appointment.startsAt,
      staffId: appointment.staffId,
      staffIds: staffOrder,
      granularity,
    });
    if (move) {
      event.preventDefault();
      props.onMove(appointment, move);
    }
  }

  const indexed = useMemo(() => indexCalendar(visible, timeZone), [visible, timeZone]);
  const groupedWindows = useMemo(() => staffByDay(workingWindows), [workingWindows]);
  const groupedOffs = useMemo(() => staffByDay(timeOff), [timeOff]);
  const prepared = useMemo(
    () =>
      columns.map((column) => {
        const entries = indexed.byColumn.get(`${column.staffId}:${column.date}`) ?? [];
        const live = layoutBlocks(
          entries.filter((e) => e.appointment.status !== "cancelled"),
          timeZone,
          gridStart,
          column.date,
          MIN_BLOCK_PX / PX_PER_MINUTE,
        );
        const cancelled = layoutBlocks(
          entries.filter((e) => e.appointment.status === "cancelled"),
          timeZone,
          gridStart,
          column.date,
          MIN_BLOCK_PX / PX_PER_MINUTE,
        ).map((block) => ({ ...block, lane: 0, lanes: 1 }));
        return {
          column,
          entries: new Map(entries.map((entry) => [entry.id, entry])),
          blocks: [...cancelled, ...live],
          windows: groupedWindows.get(column.staffId) ?? [],
          offs: groupedOffs.get(column.staffId) ?? [],
        };
      }),
    [columns, indexed, groupedWindows, groupedOffs, timeZone, gridStart],
  );

  return (
    <section
      ref={viewport}
      aria-label={t("calendar.title")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard reachable
      tabIndex={0}
      className="salon-calendar overflow-auto rounded-xl border border-line bg-surface"
    >
      <div className="min-w-fit">
        <div
          className="calendar-grid-head grid border-b border-line bg-surface"
          style={{ gridTemplateColumns: `4rem repeat(${columns.length}, minmax(10.5rem, 1fr))` }}
        >
          <div className="sticky left-0 z-10 bg-surface" />
          {columns.map((column) => (
            <div key={column.key} className="calendar-column-heading border-l border-line">
              <span
                className="calendar-avatar"
                aria-hidden="true"
                style={{ "--person-hue": serviceHue(column.title) } as CSSProperties}
              >
                {personInitials(column.title)}
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{column.title}</p>
                {column.subtitle && (
                  <p className="mt-1 truncate text-[0.65rem] text-muted" title={column.subtitle}>
                    {column.subtitle}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>

        <div
          className="grid"
          style={{ gridTemplateColumns: `4rem repeat(${columns.length}, minmax(10.5rem, 1fr))` }}
        >
          <div
            className="calendar-time-axis sticky left-0 z-10 bg-surface"
            style={{ height }}
            aria-hidden="true"
          >
            {hours.map((hour) => (
              <div key={hour} className="relative" style={{ height: 60 * PX_PER_MINUTE }}>
                <span className="absolute -top-2.5 right-2 text-xs tabular-nums whitespace-nowrap text-muted">
                  {hour === startHour
                    ? ""
                    : formatTime(
                        zonedInstant(
                          columns[0]?.date ?? today,
                          `${String(hour).padStart(2, "0")}:00`,
                          timeZone,
                        ),
                        timeZone,
                        locale,
                      )}
                </span>
              </div>
            ))}
          </div>

          {prepared.map(({ column, entries, blocks, windows, offs }) => {
            const clip = (startsAt: string, endsAt: string) => {
              const range = localMinuteRange({ startsAt, endsAt }, column.date, timeZone);
              if (!range) return null;
              const top = Math.max(gridStart, range.start);
              const bottom = Math.min(endHour * 60, range.end);
              return bottom > top
                ? { top: (top - gridStart) * PX_PER_MINUTE, height: (bottom - top) * PX_PER_MINUTE }
                : null;
            };
            const nowMin = nowMarkerMinutes(now, column.date, timeZone);

            return (
              // biome-ignore lint/a11y/useSemanticElements: an absolutely positioned time grid cannot be a fieldset
              <div
                key={column.key}
                role="group"
                aria-label={t("calendar.grid.label", {
                  name: column.title,
                  date: column.subtitle ?? column.date,
                })}
                className="relative border-l border-line"
                style={{ height }}
              >
                {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: keyboard users create through the "New appointment" button and the n shortcut */}
                <div
                  data-testid="slot-surface"
                  ref={(el) => {
                    if (el) surfaces.current.set(column.key, el);
                    else surfaces.current.delete(column.key);
                  }}
                  className="calendar-closed absolute inset-0 cursor-cell"
                  onClick={(event) => {
                    if (
                      event.target !== event.currentTarget &&
                      !(event.target as HTMLElement).dataset.passthrough
                    )
                      return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const minutes = offsetToSnappedMinutes(
                      event.clientY - rect.top,
                      PX_PER_MINUTE,
                      granularity,
                    );
                    props.onSlotClick({
                      staffId: column.staffId,
                      date: column.date,
                      minutesOfDay: gridStart + minutes,
                    });
                  }}
                >
                  {windows.map((w) => {
                    const box = clip(w.startsAt, w.endsAt);
                    return (
                      box && (
                        <div
                          key={w.startsAt}
                          data-kind="working"
                          data-passthrough="true"
                          className="absolute inset-x-0 bg-surface"
                          style={{ top: box.top, height: box.height }}
                        />
                      )
                    );
                  })}
                  {hours.map((hour) => (
                    <div
                      key={hour}
                      aria-hidden="true"
                      data-passthrough="true"
                      className="pointer-events-none absolute inset-x-0 border-t border-line/70"
                      style={{ top: (hour - startHour) * 60 * PX_PER_MINUTE }}
                    />
                  ))}
                </div>

                {offs.map((o) => {
                  const box = clip(o.startsAt, o.endsAt);
                  return (
                    box && (
                      <div
                        key={o.id}
                        data-kind="time-off"
                        className="pointer-events-none absolute inset-x-0 overflow-hidden border-y border-line-strong bg-[repeating-linear-gradient(135deg,var(--surface-sunken)_0_8px,var(--border)_8px_10px)] px-2 py-1 text-xs font-medium text-fg"
                        style={{ top: box.top, height: box.height }}
                      >
                        <span className="calendar-time-off-label">
                          {t("calendar.grid.timeOff", { reason: o.reason ? `: ${o.reason}` : "" })}
                        </span>
                      </div>
                    )
                  );
                })}

                {blocks.map((block) => {
                  const entry = entries.get(block.id);
                  if (!entry) return null;
                  const appointment = entry.appointment;
                  const look = statusAppearance(appointment.status);
                  const Icon = ICONS[look.icon];
                  const status = t(look.labelKey);
                  const dragging = drag?.id === entry.id && drag.active;
                  const processing = processingRanges(appointment).flatMap((range) => {
                    const start = Math.max(Date.parse(range.startsAt), Date.parse(entry.startsAt));
                    const end = Math.min(Date.parse(range.endsAt), Date.parse(entry.endsAt));
                    return end > start
                      ? [
                          {
                            ...range,
                            startsAt: new Date(start).toISOString(),
                            endsAt: new Date(end).toISOString(),
                            offsetMinutes: (start - Date.parse(entry.startsAt)) / 60000,
                            minutes: (end - start) / 60000,
                          },
                        ]
                      : [];
                  });
                  const processingLabels = processing.map((range) =>
                    t("timing.processingRange", {
                      from: formatTime(range.startsAt, timeZone, locale),
                      to: formatTime(range.endsAt, timeZone, locale),
                    }),
                  );
                  const px = Math.max(block.durationMinutes * PX_PER_MINUTE, MIN_BLOCK_PX);
                  return (
                    <div
                      key={block.id}
                      data-block
                      className={cn(
                        "absolute px-0.5",
                        appointment.status === "cancelled" && "z-0 opacity-70",
                        dragging && "z-30 opacity-80",
                      )}
                      style={{
                        top: block.startMinutes * PX_PER_MINUTE,
                        height: px,
                        left: `${(block.lane / block.lanes) * 100}%`,
                        width: `${100 / block.lanes}%`,
                        transform: dragging ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined,
                      }}
                    >
                      <button
                        type="button"
                        aria-description={
                          props.canMove(appointment) ? t("calendar.grid.moveHint") : undefined
                        }
                        data-status={appointment.status}
                        data-compact={px < 42 || undefined}
                        data-dragging={dragging || undefined}
                        style={
                          {
                            "--service-hue": serviceHue(entry.services[0] ?? ""),
                            ...(entry.color ? { "--service-color": entry.color } : {}),
                          } as CSSProperties
                        }
                        title={`${formatTime(entry.startsAt, timeZone, locale)}–${formatTime(entry.endsAt, timeZone, locale)} · ${appointment.clientName} · ${entry.services.join(", ")} · ${status}`}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          props.onOpenAppointment(appointment);
                        }}
                        onKeyDown={(event) => onBlockKeyDown(event, appointment)}
                        onPointerDown={(event) => onPointerDown(event, entry)}
                        onPointerMove={onPointerMove}
                        onPointerUp={(event) => onPointerUp(event, appointment)}
                        onPointerCancel={resetDrag}
                        onLostPointerCapture={() => {
                          if (dragRef.current) resetDrag();
                        }}
                        className={cn(
                          "calendar-card isolate",
                          props.canMove(appointment) && "md:cursor-grab md:active:cursor-grabbing",

                          props.highlightId === appointment.id && "ring-2 ring-ring",
                        )}
                      >
                        {processing.map((range) => (
                          <span
                            key={range.startsAt}
                            aria-hidden="true"
                            data-processing-window
                            className="pointer-events-none absolute inset-x-0 -z-10 border-y border-dashed border-line-strong bg-surface/50"
                            style={{
                              top: `${(range.offsetMinutes / block.durationMinutes) * 100}%`,
                              height: `${(range.minutes / block.durationMinutes) * 100}%`,
                            }}
                          />
                        ))}
                        <span className="flex shrink-0 items-center gap-1 font-semibold tabular-nums calendar-card-time">
                          <span>
                            {formatTime(entry.startsAt, timeZone, locale)} –{" "}
                            {formatTime(entry.endsAt, timeZone, locale)}
                          </span>
                          {appointment.status !== "booked" && (
                            <Icon width={11} height={11} aria-label={status} />
                          )}
                          <AppointmentBadges
                            badges={appointment.serviceBadges?.filter((b) =>
                              entry.servicePositions.includes(b.servicePosition),
                            )}
                          />
                        </span>{" "}
                        <span className="min-w-0 truncate font-semibold">
                          {appointment.clientName}
                        </span>{" "}
                        <span className="calendar-card-services line-clamp-2">
                          {entry.services.join(", ")}
                        </span>{" "}
                        {processingLabels.length > 0 && (
                          <span className="truncate">{processingLabels.join(" · ")}</span>
                        )}
                        <span className="sr-only"> {status}</span>
                        {appointment.notes &&
                          !appointment.serviceBadges?.some(
                            (b) => b.customerComment || b.internalNote,
                          ) && (
                            <span
                              className="calendar-card-status absolute top-1 right-1"
                              role="img"
                              aria-label={t("calendar.hasNotes")}
                              title={t("calendar.hasNotes")}
                            >
                              ◦
                            </span>
                          )}
                      </button>
                    </div>
                  );
                })}

                {nowMin !== null && nowMin >= gridStart && nowMin <= endHour * 60 && (
                  <div
                    data-kind="now"
                    className="pointer-events-none absolute inset-x-0 z-10 border-t-2 border-danger-fg"
                    style={{ top: (nowMin - gridStart) * PX_PER_MINUTE }}
                  >
                    {column.key === firstTodayColumn && (
                      <span className="calendar-now-label absolute -top-3 left-0 rounded-r bg-danger-fg px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums text-canvas">
                        {formatTime(now.toISOString(), timeZone, locale)}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
});
