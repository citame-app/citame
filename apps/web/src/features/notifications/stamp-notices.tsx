import type { StampNoticeQuery, StampNoticeRead } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { stampNoticesQueryKey } from "~/lib/api/reward-endpoints";
import { formatDateWithYear, localDateOf } from "~/lib/format";

function noticeQuery(mode: CommerceMode, userId: string, query: StampNoticeQuery) {
  return {
    queryKey: [...stampNoticesQueryKey, mode, userId, query] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api().rewards.stampNotices(mode, query, signal),
    refetchInterval: mode === "client" ? 15_000 : 30_000,
  };
}

export function useStampNoticeCount(mode: CommerceMode, userId: string, enabled: boolean) {
  const result = useQuery({ ...noticeQuery(mode, userId, { summary: "true" }), enabled });
  return enabled ? (result.data?.unreadCount ?? 0) : 0;
}

export function StampNotices({
  mode,
  userId,
  headingLevel = 3,
  onNavigate,
}: {
  mode: CommerceMode;
  userId: string;
  headingLevel?: 2 | 3;
  onNavigate?: () => void;
}) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [unread, setUnread] = useState(false);
  const [page, setPage] = useState(1);
  const query = useQuery(noticeQuery(mode, userId, { page, unread: unread ? "true" : "false" }));
  const read = useMutation({
    mutationFn: (input: StampNoticeRead) => api().rewards.readStampNotice(mode, input),
    onSuccess: () => {
      if (unread) {
        heading.current?.focus({ preventScroll: true });
        if (query.data?.entries.length === 1 && page > 1) setPage(page - 1);
      }
    },
    onSettled: () => {
      void queries.invalidateQueries({ queryKey: [...stampNoticesQueryKey, mode, userId] });
    },
  });
  const result = query.data;
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby={id} className="space-y-3">
      <Heading id={id} ref={heading} tabIndex={-1} className="text-heading">
        {t("stamps.noticeTitle")}
      </Heading>
      <div className="flex flex-wrap gap-2">
        {[false, true].map((value) => (
          <Button
            key={String(value)}
            type="button"
            aria-pressed={unread === value}
            variant={unread === value ? "primary" : "secondary"}
            onClick={() => {
              setUnread(value);
              setPage(1);
            }}
          >
            {t(value ? "stamps.noticeUnread" : "stamps.noticeAll")}
          </Button>
        ))}
      </div>
      <p role="status" className="sr-only">
        {read.isSuccess ? t("stamps.noticeReadStatus") : ""}
      </p>
      {read.isError && <ErrorState error={read.error} />}
      {query.isPending ? (
        <Skeleton className="h-32" />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : result?.entries.length ? (
        <ul className="space-y-2">
          {result.entries.map((notice) => (
            <li
              key={notice.cardId}
              className="space-y-2 rounded-lg border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm">
                <strong>{t(notice.issued ? "stamps.noticeIssued" : "stamps.noticeEarned")}</strong>
                <time dateTime={notice.earnedAt} className="text-muted">
                  {formatDateWithYear(localDateOf(notice.earnedAt, timeZone), locale)}
                </time>
              </div>
              <p className="break-words">{notice.rewardName}</p>
              <p className="break-words text-sm text-muted">
                {notice.clientName ? `${notice.clientName} · ` : ""}
                {notice.cardName}
              </p>
              {notice.rewardExpiresAt && (
                <p className="text-sm text-muted">
                  {t("stamps.expires", {
                    date: formatDateWithYear(
                      localDateOf(
                        new Date(Date.parse(notice.rewardExpiresAt) - 1).toISOString(),
                        timeZone,
                      ),
                      locale,
                    ),
                  })}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {mode === "admin" && notice.clientId ? (
                  <Link
                    to="/admin/commerce"
                    search={{ view: "rewards", rewardClient: notice.clientId }}
                    className={buttonClasses({ variant: "secondary" })}
                    onClick={onNavigate}
                  >
                    {t("stamps.noticeOpen")}
                  </Link>
                ) : (
                  <Link
                    to="/account/rewards"
                    search={{ stamps: true }}
                    className={buttonClasses({ variant: "secondary" })}
                    onClick={onNavigate}
                  >
                    {t("stamps.noticeOpen")}
                  </Link>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  aria-disabled={notice.read || read.isPending || !online}
                  onClick={() => {
                    if (!notice.read && !read.isPending && online)
                      read.mutate({
                        cardId: notice.cardId,
                        revision: notice.revision,
                        generation: result.generation,
                      });
                  }}
                >
                  {t(notice.read ? "stamps.noticeReadState" : "stamps.noticeRead")}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={t("stamps.noticeEmpty")} />
      )}
      {(page > 1 || Boolean(result && page * result.pageSize < result.total)) && (
        <div className="flex flex-wrap gap-2">
          {page > 1 && (
            <Button variant="secondary" onClick={() => setPage(page - 1)}>
              {t("waitlist.previous")}
            </Button>
          )}
          {result && page * result.pageSize < result.total && (
            <Button variant="secondary" onClick={() => setPage(page + 1)}>
              {t("waitlist.next")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
