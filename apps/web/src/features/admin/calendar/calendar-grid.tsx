import type { CalendarAppointment, TimeOff, WorkingWindow } from "@sob/contracts";
import { type KeyboardEvent, type PointerEvent, useMemo, useRef, useState } from "react";
import { AlertIcon, CheckIcon, ClockIcon, GripIcon, SlashIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { cn } from "~/lib/cn";
import { formatTime, localDateOf } from "~/lib/format";
import { processingRanges } from "~/lib/processing";
import { localDayBounds, zonedInstant } from "~/lib/zoned";
import { type ColumnRect, dropTarget, exceedsDragThreshold } from "./drag";
import { keyboardMove } from "./keys";
import {
  gridHours,
  layoutBlocks,
  nowMarkerMinutes,
  offsetToSnappedMinutes,
  statusAppearance,
} from "./logic";
import { STATUS_CLASSES } from "./status-badge";

/** Pixels per minute: 30 minutes is ~48px, tall enough to read and to tap. */
export const PX_PER_MINUTE = 1.6;
const MIN_BLOCK_PX = 44;
const ICONS = { clock: ClockIcon, check: CheckIcon, slash: SlashIcon, alert: AlertIcon };

export interface GridColumn {
  key: string;
  staffId: string;
  date: string;
  title: string;
  subtitle?: string;
}

export interface MoveRequest {
  staffId: string;
  startsAt: string;
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

export function CalendarGrid(props: CalendarGridProps) {
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
  const { startHour, endHour } = gridHours(workingWindows, visible, timeZone);
  const gridStart = startHour * 60;
  const height = (endHour - startHour) * 60 * PX_PER_MINUTE;
  const surfaces = useRef(new Map<string, HTMLElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  const suppressClick = useRef(false);
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

  function onPointerDown(event: PointerEvent<HTMLButtonElement>, appointment: CalendarAppointment) {
    if (event.pointerType === "touch" || event.button !== 0 || !props.canMove(appointment)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = event.currentTarget.closest<HTMLElement>("[data-block]")?.getBoundingClientRect();
    setDrag({
      id: appointment.id,
      pointerId: event.pointerId,
      start: { x: event.clientX, y: event.clientY },
      grabOffsetY: rect ? event.clientY - rect.top : 0,
      dx: 0,
      dy: 0,
      active: false,
    });
  }

  function onPointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = { x: event.clientX, y: event.clientY };
    setDrag({
      ...drag,
      dx: next.x - drag.start.x,
      dy: next.y - drag.start.y,
      active: drag.active || exceedsDragThreshold(drag.start, next),
    });
  }

  function onPointerUp(event: PointerEvent<HTMLButtonElement>, appointment: CalendarAppointment) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    const finished = drag;
    setDrag(null);
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

  return (
    <section
      aria-label={t("calendar.title")}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a horizontally scrollable region must be keyboard reachable
      tabIndex={0}
      className="salon-calendar overflow-x-auto rounded-xl border border-line bg-surface"
    >
      <div className="min-w-fit">
        <div
          className="grid border-b border-line bg-surface"
          style={{ gridTemplateColumns: `4.5rem repeat(${columns.length}, minmax(9.5rem, 1fr))` }}
        >
          <div className="sticky left-0 z-10 bg-surface" />
          {columns.map((column) => (
            <div key={column.key} className="border-l border-line px-2 py-2 text-center">
              <p className="truncate font-medium">{column.title}</p>
              {column.subtitle && <p className="text-xs text-muted">{column.subtitle}</p>}
            </div>
          ))}
        </div>

        <div
          className="grid"
          style={{ gridTemplateColumns: `4.5rem repeat(${columns.length}, minmax(9.5rem, 1fr))` }}
        >
          <div className="sticky left-0 z-10 bg-surface" style={{ height }} aria-hidden="true">
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

          {columns.map((column) => {
            const dayBounds = localDayBounds(column.date, timeZone);
            const dayStart = Date.parse(dayBounds.from);
            const minuteOf = (instant: string) => (Date.parse(instant) - dayStart) / 60_000;
            const clip = (startsAt: string, endsAt: string) => {
              const top = Math.max(0, minuteOf(startsAt) - gridStart);
              const bottom = Math.min((endHour - startHour) * 60, minuteOf(endsAt) - gridStart);
              return bottom > top
                ? { top: top * PX_PER_MINUTE, height: (bottom - top) * PX_PER_MINUTE }
                : null;
            };
            const colAppointments = visible.filter(
              (a) =>
                a.staffId === column.staffId && localDateOf(a.startsAt, timeZone) === column.date,
            );
            // Cancelled appointments sit behind the live ones at full width, so a pile of them in one
            // slot never squeezes the real bookings into thin lanes.
            const live = layoutBlocks(
              colAppointments.filter((a) => a.status !== "cancelled"),
              timeZone,
              gridStart,
            );
            const cancelled = layoutBlocks(
              colAppointments.filter((a) => a.status === "cancelled"),
              timeZone,
              gridStart,
            ).map((b) => ({ ...b, lane: 0, lanes: 1 }));
            const blocks = [...cancelled, ...live];
            const windows = workingWindows.filter((w) => w.staffId === column.staffId);
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
                  className="absolute inset-0 cursor-cell bg-sunken"
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

                {timeOff
                  .filter((o) => o.staffId === column.staffId)
                  .map((o) => {
                    const box = clip(o.startsAt, o.endsAt);
                    return (
                      box && (
                        <div
                          key={o.id}
                          data-kind="time-off"
                          className="pointer-events-none absolute inset-x-0 overflow-hidden border-y border-line-strong bg-[repeating-linear-gradient(135deg,var(--surface-sunken)_0_8px,var(--border)_8px_10px)] px-2 py-1 text-xs font-medium text-fg"
                          style={{ top: box.top, height: box.height }}
                        >
                          {t("calendar.grid.timeOff", { reason: o.reason ? `: ${o.reason}` : "" })}
                        </div>
                      )
                    );
                  })}

                {blocks.map((block) => {
                  const appointment = colAppointments.find(
                    (a) => a.id === block.id,
                  ) as CalendarAppointment;
                  const look = statusAppearance(appointment.status);
                  const Icon = ICONS[look.icon];
                  const status = t(look.labelKey);
                  const dragging = drag?.id === appointment.id && drag.active;
                  const processing = processingRanges(appointment);
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
                        aria-label={t("calendar.block.label", {
                          time: formatTime(appointment.startsAt, timeZone, locale),
                          client: appointment.clientName,
                          services: appointment.serviceNames.join(", "),
                          status: [...processingLabels, status].join(" · "),
                        })}
                        aria-description={
                          props.canMove(appointment) ? t("calendar.grid.moveHint") : undefined
                        }
                        data-status={appointment.status}
                        onClick={() => {
                          if (suppressClick.current) {
                            suppressClick.current = false;
                            return;
                          }
                          props.onOpenAppointment(appointment);
                        }}
                        onKeyDown={(event) => onBlockKeyDown(event, appointment)}
                        onPointerDown={(event) => onPointerDown(event, appointment)}
                        onPointerMove={onPointerMove}
                        onPointerUp={(event) => onPointerUp(event, appointment)}
                        onPointerCancel={() => setDrag(null)}
                        className={cn(
                          "relative isolate flex size-full flex-col overflow-hidden rounded-md border px-2 py-1 text-left text-xs leading-tight shadow-sm transition-shadow hover:shadow-md",
                          props.canMove(appointment) && "md:cursor-grab md:active:cursor-grabbing",
                          STATUS_CLASSES[appointment.status],
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
                        <span className="flex items-center gap-1 font-semibold">
                          <Icon width={13} height={13} className="shrink-0" />
                          <span className="shrink-0 tabular-nums">
                            {formatTime(appointment.startsAt, timeZone, locale)}
                          </span>{" "}
                          <span className="truncate">{appointment.clientName}</span>
                          {props.canMove(appointment) && (
                            <GripIcon
                              width={12}
                              height={12}
                              className="ml-auto hidden shrink-0 opacity-50 md:block"
                            />
                          )}
                        </span>{" "}
                        <span className="truncate">{appointment.serviceNames.join(", ")}</span>{" "}
                        {processingLabels.length > 0 && (
                          <span className="truncate">{processingLabels.join(" · ")}</span>
                        )}{" "}
                        <span className="mt-auto truncate font-medium">{status}</span>
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
                      <span className="absolute -top-3 left-0 rounded-r bg-danger-fg px-1.5 py-0.5 text-[0.65rem] font-semibold tabular-nums text-canvas">
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
}
