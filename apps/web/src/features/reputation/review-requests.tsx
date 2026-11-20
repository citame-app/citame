import {
  REVIEW_REQUEST_MAX_PAGE,
  REVIEW_REQUEST_SEARCH_LENGTH,
  type reviewRequestsSchema,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { z } from "zod";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useCalendarLive } from "~/features/admin/calendar/live-provider";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { ApiError } from "~/lib/api/client";
import { reviewRequestQueryKey } from "~/lib/api/review-endpoints";
import { dateFormatter } from "~/lib/format";

type Visit = z.infer<typeof reviewRequestsSchema>["visits"][number];
const isAccessDenied = (error: unknown) =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

function ReviewRequest({ visit }: { visit: Visit }) {
  const { t, locale, timeZone } = useI18n();
  const [feedback, setFeedback] = useState<"copied" | "manual">();
  const descriptionId = useId();
  const [confirmEmail, setConfirmEmail] = useState(false);
  const cache = useQueryClient();
  const email = useMutation({
    mutationFn: () => api().reviews.requestEmail(visit.appointmentId),
    onSuccess: () => setConfirmEmail(false),
    onSettled: () => cache.invalidateQueries({ queryKey: reviewRequestQueryKey }),
  });
  const emailStatus = visit.emailStatus ?? email.data?.status;
  const date = dateFormatter(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(visit.startsAt));

  async function copy() {
    if (!visit.link) return;
    try {
      await navigator.clipboard.writeText(visit.link);
      setFeedback("copied");
    } catch {
      setFeedback("manual");
    }
  }

  return (
    <li className="min-w-0 space-y-2 rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div id={descriptionId} className="min-w-0">
          <p className="break-words font-medium">{visit.clientName}</p>
          <time dateTime={visit.startsAt} className="text-sm text-muted">
            {date}
          </time>
        </div>
        <div className="flex flex-wrap gap-2">
          {visit.link && (
            <Button
              variant="secondary"
              aria-describedby={descriptionId}
              onClick={() => void copy()}
            >
              {t("reviews.request.copy")}
            </Button>
          )}
          {visit.canEmail && (
            <Button
              variant="secondary"
              aria-describedby={descriptionId}
              disabled={email.isPending || Boolean(emailStatus)}
              onClick={() => {
                email.reset();
                setConfirmEmail(true);
              }}
            >
              {t("reviews.request.email")}
            </Button>
          )}
        </div>
      </div>
      <p role="status" className="text-sm text-muted">
        {feedback && t(`reviews.request.${feedback}`)}
      </p>
      {feedback === "manual" && visit.link && (
        <TextField
          label={t("reviews.request.link")}
          value={visit.link}
          readOnly
          onFocus={(event) => event.currentTarget.select()}
        />
      )}
      <p role="status" className="text-sm text-muted">
        {emailStatus
          ? t(`reviews.request.emailStatus.${emailStatus}`)
          : email.isError && !confirmEmail
            ? t("reviews.request.emailError")
            : email.isPending
              ? t("reviews.request.emailSaving")
              : null}
      </p>
      {confirmEmail && (
        <ConfirmDialog
          open={confirmEmail}
          onOpenChange={setConfirmEmail}
          onConfirm={() => email.mutate()}
          pending={email.isPending}
          title={t("reviews.request.emailTitle")}
          description={t("reviews.request.emailConfirm", { client: visit.clientName })}
          confirmLabel={t("reviews.request.email")}
          cancelLabel={t("admin.cancel")}
        >
          {email.isError && (
            <p role="alert" className="mt-3 text-sm text-muted">
              {t("reviews.request.emailError")}
            </p>
          )}
        </ConfirmDialog>
      )}
    </li>
  );
}

export function ReviewRequests() {
  const { t } = useI18n();
  const live = useCalendarLive();
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState({ search: "", page: 1 });
  const query = useQuery({
    queryKey: [...reviewRequestQueryKey, filters],
    queryFn: () => api().reviews.requests(filters),
    gcTime: 0,
    retry: (failures, error) => !isAccessDenied(error) && failures < 3,
    refetchIntervalInBackground: false,
    refetchInterval: ({ state }) =>
      !isAccessDenied(state.error) &&
      state.data?.visits.some(
        ({ emailStatus }) => emailStatus === "pending" || emailStatus === "processing",
      )
        ? live
          ? 15_000
          : 3000
        : false,
  });
  const data = isAccessDenied(query.error) ? undefined : query.data;

  return (
    <section className="space-y-4">
      <p className="max-w-prose text-sm text-muted">{t("reviews.request.lead")}</p>
      {data?.emailEnabled && (
        <p className="max-w-prose text-sm text-muted">{t("reviews.request.emailEligibility")}</p>
      )}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ search: draft.trim(), page: 1 });
        }}
      >
        <TextField
          label={t("reviews.request.search")}
          value={draft}
          maxLength={REVIEW_REQUEST_SEARCH_LENGTH}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <Button type="submit" variant="secondary">
          {t("reviews.request.find")}
        </Button>
      </form>
      {query.isPending && <Skeleton className="h-40" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {data?.visits.length === 0 && <EmptyState title={t("reviews.request.empty")} />}
      {data && data.visits.length > 0 && (
        <ul className="space-y-2">
          {data.visits.map((visit) => (
            <ReviewRequest key={visit.appointmentId} visit={visit} />
          ))}
        </ul>
      )}
      {data && (filters.page > 1 || data.hasMore) && (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            disabled={filters.page === 1}
            onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
          >
            {t("reviews.request.previous")}
          </Button>
          <Button
            variant="ghost"
            disabled={!data.hasMore || filters.page >= REVIEW_REQUEST_MAX_PAGE}
            onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
          >
            {t("reviews.request.next")}
          </Button>
        </div>
      )}
    </section>
  );
}
