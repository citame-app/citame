import type { CalendarInboxQuery, CalendarNotice } from "@sob/contracts";
import {
  type QueryClient,
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { BellIcon } from "~/components/ui/icons";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { StampNotices, useStampNoticeCount } from "~/features/notifications/stamp-notices";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatTime, localDateOf } from "~/lib/format";

const inboxKey = (userId: string) => ["calendar-inbox", userId] as const;

function isAccessDenied(error: unknown) {
  return error instanceof ApiError && (error.status === 401 || error.status === 403);
}

async function clearInboxAccess(queries: QueryClient, userId: string, failingKey?: QueryKey) {
  const scope = { queryKey: inboxKey(userId) };
  // Cancel older reads before they can put the prior pages back in the cache.
  await queries.cancelQueries({ ...scope, predicate: ({ queryKey }) => queryKey !== failingKey });
  queries.setQueriesData(scope, null);
}

function useCalendarInboxQuery(
  userId: string,
  accessScope?: string,
  query: CalendarInboxQuery = {},
) {
  const queries = useQueryClient();
  return useQuery({
    queryKey: [...inboxKey(userId), accessScope, query],
    queryFn: async ({ signal, queryKey }) => {
      try {
        return await api().calendarInbox.list(query, signal);
      } catch (error) {
        if (!isAccessDenied(error)) throw error;
        await clearInboxAccess(queries, userId, queryKey);
        return null;
      }
    },
    refetchInterval: 30_000,
  });
}

export function CalendarInbox({
  userId,
  accessScope,
  rewardAccess = false,
}: {
  userId: string;
  accessScope?: string;
  rewardAccess?: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const count = useCalendarInboxQuery(userId, accessScope);
  const rewards = useStampNoticeCount("admin", userId, rewardAccess);
  const total = (count.data?.total ?? 0) + rewards;
  return (
    <>
      <button
        type="button"
        className="calendar-icon-button calendar-inbox-trigger"
        aria-label={`${t("calendar.inbox.title")}${total ? ` ${Math.min(total, 99)}${total > 99 ? "+" : ""}` : ""}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <BellIcon />
        {Boolean(total) && (
          <span className="calendar-inbox-count" aria-hidden="true">
            {Math.min(total, 99)}
            {total > 99 ? "+" : ""}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title={t("calendar.inbox.title")}
        dimBackground={false}
      >
        {open && (
          <InboxSections
            userId={userId}
            accessScope={accessScope}
            rewardAccess={rewardAccess}
            onNavigate={() => setOpen(false)}
          />
        )}
      </Sheet>
    </>
  );
}

function InboxSections({
  userId,
  accessScope,
  rewardAccess,
  onNavigate,
}: {
  userId: string;
  accessScope?: string;
  rewardAccess: boolean;
  onNavigate: () => void;
}) {
  const { t } = useI18n();
  const [rewards, setRewards] = useState(false);
  return (
    <div className="space-y-4">
      {rewardAccess && (
        <div className="flex flex-wrap gap-2">
          {[false, true].map((value) => (
            <Button
              key={String(value)}
              variant={rewards === value ? "primary" : "secondary"}
              aria-pressed={rewards === value}
              onClick={() => setRewards(value)}
            >
              {t(value ? "stamps.noticeTitle" : "stamps.noticeBookings")}
            </Button>
          ))}
        </div>
      )}
      {rewards && rewardAccess ? (
        <StampNotices mode="admin" userId={userId} onNavigate={onNavigate} />
      ) : (
        <InboxContents userId={userId} accessScope={accessScope} onNavigate={onNavigate} />
      )}
    </div>
  );
}

function InboxContents({
  onNavigate,
  userId,
  accessScope,
}: {
  onNavigate: () => void;
  userId: string;
  accessScope?: string;
}) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [archived, setArchived] = useState(false);
  const [kind, setKind] = useState<CalendarInboxQuery["kind"]>();
  const [page, setPage] = useState(1);
  const query = useCalendarInboxQuery(userId, accessScope, {
    archived: archived ? "true" : "false",
    ...(kind ? { kind } : {}),
    page,
  });
  const archive = useMutation({
    mutationFn: (ids: string[]) => api().calendarInbox.archive(ids, !archived),
    onSuccess: () => {
      setPage(1);
      void queries.invalidateQueries({ queryKey: inboxKey(userId) });
    },
    onError: async (error) => {
      if (isAccessDenied(error)) await clearInboxAccess(queries, userId);
    },
  });
  const groups = new Map<string, CalendarNotice[]>();
  for (const notice of query.data?.entries ?? []) {
    const day = localDateOf(notice.createdAt, timeZone);
    groups.set(day, [...(groups.get(day) ?? []), notice]);
  }
  return (
    <div className="space-y-5">
      <fieldset className="flex gap-2">
        <legend className="sr-only">{t("calendar.inbox.state")}</legend>
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            variant={archived === value ? "primary" : "secondary"}
            aria-pressed={archived === value}
            onClick={() => {
              setArchived(value);
              setPage(1);
            }}
          >
            {t(value ? "calendar.inbox.archived" : "calendar.inbox.active")}
          </Button>
        ))}
      </fieldset>
      <label className="block text-sm font-medium">
        {t("calendar.inbox.filter")}
        <select
          className="mt-2 min-h-11 w-full rounded-md border border-line bg-surface px-3"
          value={kind ?? ""}
          onChange={(e) => {
            setKind((e.target.value || undefined) as typeof kind);
            setPage(1);
          }}
        >
          <option value="">{t("calendar.inbox.all")}</option>
          {(["new", "rescheduled", "cancelled"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`calendar.live.${value}`)}
            </option>
          ))}
        </select>
      </label>
      {archive.isError && !isAccessDenied(archive.error) && <ErrorState error={archive.error} />}
      {query.isPending ? (
        <Skeleton className="h-48" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data === null ? (
        <EmptyState title={t("calendar.inbox.unavailable")}>
          <Button
            variant="secondary"
            onClick={() =>
              void queries.refetchQueries({ queryKey: inboxKey(userId), type: "active" })
            }
          >
            {t("common.retry")}
          </Button>
        </EmptyState>
      ) : (
        <>
          {!query.data.entries.length && <EmptyState title={t("calendar.inbox.empty")} />}
          {[...groups].map(([day, notices]) => (
            <section key={day} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{formatDateLong(day, locale)}</h3>
                {!archived && (
                  <Button
                    variant="ghost"
                    disabled={!online || archive.isPending}
                    onClick={() => archive.mutate(notices.map((n) => n.id))}
                  >
                    {t("calendar.inbox.archiveDay")}
                  </Button>
                )}
              </div>
              <ul className="divide-y divide-line">
                {notices.map((notice) => (
                  <li key={notice.id} className="calendar-inbox-entry">
                    <BellIcon width={18} height={18} />
                    <div className="min-w-0 flex-1">
                      <Link
                        to="/admin/calendar"
                        search={{
                          view: "day",
                          date: localDateOf(notice.appointmentStartsAt, timeZone),
                          staff: notice.staffId,
                          appointment: notice.appointmentId,
                        }}
                        className="block space-y-1"
                        onClick={onNavigate}
                      >
                        <span className="block text-xs font-semibold uppercase text-muted">
                          {t(`calendar.live.${notice.kind}`)}
                        </span>
                        <strong className="block text-sm">
                          {formatDateLong(localDateOf(notice.startsAt, timeZone), locale)} ·{" "}
                          {formatTime(notice.startsAt, timeZone, locale)}
                        </strong>
                        <span className="block break-words text-sm text-muted">
                          {notice.clientName} · {notice.serviceNames.join(", ")}
                        </span>
                      </Link>
                      <Button
                        variant="ghost"
                        className="mt-1"
                        disabled={!online || archive.isPending}
                        onClick={() => archive.mutate([notice.id])}
                      >
                        {t(archived ? "calendar.inbox.restore" : "calendar.inbox.archive")}
                      </Button>
                    </div>
                    <span className="calendar-person-avatar" aria-hidden="true">
                      {notice.clientName
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part[0])
                        .join("")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {query.data.total > query.data.pageSize && (
            <div className="flex items-center justify-between gap-2">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                {t("waitlist.previous")}
              </Button>
              <span className="text-sm text-muted">
                {t("waitlist.page", { page, count: query.data.total })}
              </span>
              <Button
                variant="secondary"
                disabled={page * query.data.pageSize >= query.data.total}
                onClick={() => setPage(page + 1)}
              >
                {t("waitlist.next")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
