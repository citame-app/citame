import type { Appointment, CalendarResponse, SyncEntity, SyncLiveView } from "@sob/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { BellIcon, CloseIcon } from "~/components/ui/icons";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatTime, localDateOf } from "~/lib/format";
import { connectCalendarLive } from "./live-connection";
import { liveQueryKeys } from "./live-queries";

const LiveContext = createContext<boolean | undefined>(undefined);
const InventoryRevisionContext = createContext(0);
export const useCalendarLive = () => useContext(LiveContext);
export const useInventoryLiveRevision = () => useContext(InventoryRevisionContext);
interface Notice {
  key: string;
  kind: "new" | "rescheduled" | "cancelled";
  appointment: Appointment & { clientName?: string };
}

export function CalendarLiveProvider({
  children,
  staffId,
  refreshAccess,
}: {
  children: ReactNode;
  staffId?: string | null;
  refreshAccess?: (signal: AbortSignal) => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [notices, setNotices] = useState<Notice[]>([]);
  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const known = new Map<string, Appointment>();
    const versions = new Map<string, number>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let accessRequest: AbortController | undefined;
    function refreshSession() {
      if (!refreshAccess) return;
      accessRequest?.abort();
      const current = new AbortController();
      accessRequest = current;
      void refreshAccess(current.signal).catch(() => {});
    }
    const pending = new Set<SyncEntity | SyncLiveView>();
    let reconcile = false;
    function refresh(entities?: (SyncEntity | SyncLiveView)[]) {
      if (entities) for (const entity of entities) pending.add(entity);
      else reconcile = true;
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        for (const queryKey of liveQueryKeys(reconcile ? undefined : pending)) {
          if (queryKey[0] === "inventory") {
            // A movement received during a pending page GET must select a fresh query.
            setInventoryRevision((current) => current + 1);
            void queryClient.invalidateQueries({
              queryKey,
              predicate: (query) => query.queryKey[1] !== "ledger",
            });
          } else if (
            queryKey[0] === "staff" ||
            queryKey[0] === "portfolio" ||
            queryKey[0] === "marketing" ||
            ((queryKey[0] === "rewards" || queryKey[0] === "creative") &&
              queryKey[1] === "promotions") ||
            (queryKey[0] === "rewards" &&
              (queryKey[1] === "policy" || queryKey[1] === "admin" || queryKey[1] === "stamps")) ||
            queryKey[0] === "intake" ||
            queryKey[0] === "booking-policy" ||
            queryKey[0] === "salon" ||
            (queryKey[0] === "commerce" && queryKey[1] === "transactions") ||
            (queryKey[0] === "admin" &&
              (queryKey[1] === "calendar" ||
                queryKey[1] === "staff" ||
                queryKey[1] === "staff-access" ||
                queryKey[1] === "services" ||
                queryKey[1] === "booking-policy" ||
                queryKey[1] === "email-delivery" ||
                queryKey[1] === "whatsapp"))
          ) {
            // A pending first load can otherwise reuse a response started before the event.
            void queryClient.cancelQueries({ queryKey }).then(() => {
              if (!closed) return queryClient.invalidateQueries({ queryKey });
            });
          } else if (queryKey[0] === "commerce" && queryKey.length === 1) {
            // A pending first load can also miss a payment observed by the stream.
            void queryClient.cancelQueries({ queryKey: ["commerce", "transactions"] }).then(() => {
              if (!closed) return queryClient.invalidateQueries({ queryKey });
            });
          } else {
            void queryClient.invalidateQueries({ queryKey });
          }
        }
        reconcile = false;
        pending.clear();
      }, 80);
    }
    let closed = false;
    const close = connectCalendarLive({
      open: () => new EventSource("/api/sync/stream"),
      networkTarget: window,
      pull: (since, signal) => api().sync.pull(since, signal),
      onConnection: setLive,
      onRefresh: () => {
        refresh();
        refreshSession();
      },
      onAccessExpired: refreshSession,
      onChanges: (changes, views) => {
        refresh([...changes.map(({ entity }) => entity), ...views]);
        if (
          changes.some((change) => change.entity === "staff" && (!staffId || change.id === staffId))
        )
          refreshSession();
        if (!changes.some(({ entity }) => entity === "appointment")) return;
        // Current caches provide the previous state, including optimistic local changes.
        for (const [, calendar] of queryClient.getQueriesData<CalendarResponse>({
          queryKey: ["admin", "calendar"],
        }))
          for (const appointment of calendar?.appointments ?? [])
            if (!known.has(appointment.id)) known.set(appointment.id, appointment);
        for (const change of changes) {
          if (change.entity !== "appointment") continue;
          if (change.op === "delete") {
            known.delete(change.id);
            continue;
          }
          const appointment = change.data;
          if ((versions.get(appointment.id) ?? 0) >= appointment.version) continue;
          const previous = known.get(appointment.id);
          const kind: Notice["kind"] | null =
            appointment.status === "cancelled" && previous && previous.status !== "cancelled"
              ? "cancelled"
              : previous &&
                  (previous.startsAt !== appointment.startsAt ||
                    previous.staffId !== appointment.staffId)
                ? "rescheduled"
                : !previous && appointment.version === 1
                  ? "new"
                  : null;
          versions.set(appointment.id, appointment.version);
          known.set(appointment.id, appointment);
          if (kind)
            setNotices((current) =>
              [
                { key: `${appointment.id}:${appointment.version}`, kind, appointment },
                ...current,
              ].slice(0, 3),
            );
        }
        // Bound memory for long-running reception sessions.
        while (known.size > 2000) {
          const id = known.keys().next().value;
          if (!id) break;
          known.delete(id);
          versions.delete(id);
        }
      },
    });
    return () => {
      closed = true;
      close();
      accessRequest?.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [queryClient, staffId, refreshAccess]);
  return (
    <LiveContext.Provider value={live}>
      <InventoryRevisionContext.Provider value={inventoryRevision}>
        {children}
      </InventoryRevisionContext.Provider>
      <div className="calendar-live-notices" aria-live="polite" aria-relevant="additions">
        {notices.map((notice) => (
          <AppointmentNotice
            key={notice.key}
            notice={notice}
            onDismiss={() =>
              setNotices((current) => current.filter((entry) => entry.key !== notice.key))
            }
          />
        ))}
      </div>
    </LiveContext.Provider>
  );
}

function AppointmentNotice({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const { t, locale, timeZone } = useI18n();
  const [paused, setPaused] = useState(false);
  const { appointment } = notice;
  const dateLabel = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${localDateOf(appointment.startsAt, timeZone)}T12:00:00Z`));
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(onDismiss, 15_000);
    return () => clearTimeout(timer);
  }, [paused, onDismiss]);
  return (
    <section
      className="calendar-live-notice"
      aria-label={t(`calendar.live.${notice.kind}`)}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false);
      }}
    >
      <BellIcon width={24} height={24} />
      <Link
        to="/admin/calendar"
        search={{
          view: "day",
          date: localDateOf(appointment.startsAt, timeZone),
          staff: appointment.staffId,
          appointment: appointment.id,
        }}
        className="calendar-live-notice-content"
        onClick={onDismiss}
      >
        <span className="sr-only">{t("calendar.live.open")} </span>
        <span className="calendar-live-notice-title">{t(`calendar.live.${notice.kind}`)}</span>
        <strong>
          {dateLabel} · {formatTime(appointment.startsAt, timeZone, locale)}
        </strong>
        <span>
          {appointment.clientName ?? t("drawer.client")} ·{" "}
          {appointment.services.map((service) => service.name).join(", ")}
        </span>
      </Link>
      <span className="calendar-live-avatar" aria-hidden="true">
        {appointment.clientName?.slice(0, 2) ?? "•"}
      </span>
      <button type="button" aria-label={t("common.dismiss")} onClick={onDismiss}>
        <CloseIcon />
      </button>
    </section>
  );
}
