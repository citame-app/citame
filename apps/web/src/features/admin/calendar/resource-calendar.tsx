import type { CalendarAppointment, CalendarResponse, ResourceOccupancy } from "@sob/contracts";
import { useId, useLayoutEffect, useMemo, useState } from "react";
import { EmptyState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { observeResourceSnapshot } from "~/lib/admin-queries";
import { formatTime } from "~/lib/format";

type Pool = ResourceOccupancy["pools"][number];
type OccupancyWindow = Pool["windows"][number];
type Cell = {
  pool: Pool;
  rowSpan: number;
  quantity: number;
  held: number;
  appointmentIds: string[];
};

function occupancyRows(pools: Pool[], from: number, to: number, now: number) {
  const boundaries = new Set([from, to]);
  const changes = pools.map((pool) => {
    const events = new Map<number, { added: OccupancyWindow[]; removed: OccupancyWindow[] }>();
    const at = (instant: number) => {
      let event = events.get(instant);
      if (!event) {
        event = { added: [], removed: [] };
        events.set(instant, event);
      }
      return event;
    };
    at(from);
    at(to);
    for (const window of pool.windows) {
      if (window.holdExpiresAt && Date.parse(window.holdExpiresAt) <= now) continue;
      const start = Math.max(from, Date.parse(window.startsAt));
      const end = Math.min(to, Date.parse(window.endsAt));
      if (!(start < end)) continue;
      at(start).added.push(window);
      at(end).removed.push(window);
      boundaries.add(start);
      boundaries.add(end);
    }
    return { pool, events };
  });
  const instants = [...boundaries].sort((a, b) => a - b);
  const index = new Map(instants.map((instant, i) => [instant, i]));
  const rows = instants.slice(0, -1).map((start, i) => ({
    start,
    end: instants[i + 1] as number,
    cells: [] as Cell[],
  }));
  for (const { pool, events } of changes) {
    const ownTimes = [...events.keys()].sort((a, b) => a - b);
    let quantity = 0;
    let held = 0;
    const appointments = new Map<string, number>();
    for (const [i, instant] of ownTimes.entries()) {
      const next = ownTimes[i + 1];
      const rowIndex = index.get(instant);
      const nextIndex = next === undefined ? undefined : index.get(next);
      const event = events.get(instant);
      if (!event || rowIndex === undefined || nextIndex === undefined) break;
      for (const window of event.removed) {
        quantity -= window.quantity;
        if (window.holdExpiresAt) held -= window.quantity;
        if (window.appointmentId) {
          const count = appointments.get(window.appointmentId) ?? 0;
          if (count <= 1) appointments.delete(window.appointmentId);
          else appointments.set(window.appointmentId, count - 1);
        }
      }
      for (const window of event.added) {
        quantity += window.quantity;
        if (window.holdExpiresAt) held += window.quantity;
        if (window.appointmentId)
          appointments.set(window.appointmentId, (appointments.get(window.appointmentId) ?? 0) + 1);
      }
      rows[rowIndex]?.cells.push({
        pool,
        rowSpan: nextIndex - rowIndex,
        quantity,
        held,
        appointmentIds: [...appointments.keys()],
      });
    }
  }
  return rows;
}

export function ResourceCalendar({
  calendar,
  onOpen,
}: {
  calendar: CalendarResponse;
  onOpen: (appointment: CalendarAppointment) => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const caption = useId();
  const { resourceOccupancy, from, to, appointments } = calendar;
  const [expired, setExpired] = useState<{ source: ResourceOccupancy; through: number } | null>(
    null,
  );
  const captured = Date.parse(resourceOccupancy?.capturedAt ?? "");
  const instant = expired && expired.source === resourceOccupancy ? expired.through : captured;
  useLayoutEffect(() => {
    if (!resourceOccupancy) return;
    const deadlines = new Set<number>();
    for (const pool of resourceOccupancy.pools) {
      for (const window of pool.windows) {
        if (window.holdExpiresAt) {
          const expiry = Date.parse(window.holdExpiresAt);
          if (expiry > captured) deadlines.add(expiry);
        }
      }
    }
    const times = [...deadlines].sort((a, b) => a - b);
    const observed = observeResourceSnapshot(resourceOccupancy);
    let cursor = 0;
    let timer: number | undefined;
    function schedule() {
      const serverTime = captured + (performance.now() - observed);
      const prior = cursor;
      let deadline = times[cursor];
      while (deadline !== undefined && deadline <= serverTime) {
        cursor += 1;
        deadline = times[cursor];
      }
      if (prior !== cursor && resourceOccupancy)
        setExpired({ source: resourceOccupancy, through: serverTime });
      if (deadline !== undefined)
        timer = window.setTimeout(schedule, Math.ceil(deadline - serverTime));
    }
    schedule();
    return () => window.clearTimeout(timer);
  }, [captured, resourceOccupancy]);
  const rows = useMemo(
    () => occupancyRows(resourceOccupancy?.pools ?? [], Date.parse(from), Date.parse(to), instant),
    [resourceOccupancy, from, to, instant],
  );
  const byId = useMemo(
    () => new Map(appointments.map((appointment) => [appointment.id, appointment])),
    [appointments],
  );
  const repeatedHour = Date.parse(to) - Date.parse(from) > 86_400_000;
  const withOffset = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "shortOffset",
      }),
    [locale, timeZone],
  );
  const time = (value: number) =>
    repeatedHour
      ? withOffset.format(value)
      : formatTime(new Date(value).toISOString(), timeZone, locale);

  if (!resourceOccupancy) return <EmptyState title={t("calendar.resources.unavailable")} />;
  if (resourceOccupancy.pools.length === 0)
    return <EmptyState title={t("calendar.resources.empty")} />;

  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users need to reach the scroll region.
    <section className="calendar-resource-scroll" aria-labelledby={caption} tabIndex={0}>
      <table className="calendar-resource-table">
        <caption id={caption} className="sr-only">
          {t("calendar.view.resources")}
        </caption>
        <thead>
          <tr>
            <th scope="col" className="calendar-resource-time">
              {t("calendar.resources.time")}
            </th>
            {resourceOccupancy.pools.map((pool) => (
              <th scope="col" key={pool.id}>
                <strong>{pool.name}</strong>
                <span>{t("calendar.resources.capacity", { count: pool.capacity })}</span>
                {!pool.active && <span>{t("calendar.resources.inactive")}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ start, end, cells }) => (
            <tr key={start}>
              <th scope="row" className="calendar-resource-time">
                <time dateTime={new Date(start).toISOString()}>{time(start)}</time>
                <span aria-hidden="true">–</span>
                <time dateTime={new Date(end).toISOString()}>{time(end)}</time>
              </th>
              {cells.map(({ pool, rowSpan, quantity, held, appointmentIds }) => (
                <td key={pool.id} rowSpan={rowSpan} data-occupied={quantity > 0 || undefined}>
                  <strong>
                    {t("calendar.resources.reserved", { count: quantity, capacity: pool.capacity })}
                  </strong>
                  {held > 0 && <span>{t("calendar.resources.held", { count: held })}</span>}
                  {appointmentIds.map((id) => {
                    const appointment = byId.get(id);
                    return (
                      appointment && (
                        <button key={id} type="button" onClick={() => onOpen(appointment)}>
                          {appointment.clientName}
                        </button>
                      )
                    );
                  })}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
