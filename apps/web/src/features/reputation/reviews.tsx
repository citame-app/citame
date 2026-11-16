import type { ReviewPrivate, ReviewPublic } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { SelectField, TextAreaField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { UnsavedGuard } from "~/features/admin/unsaved-guard";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { servicesQuery } from "~/lib/queries";
import { ReviewEditor, ReviewFailure } from "./review-editor";

export function ReviewContent({ review }: { review: ReviewPublic | ReviewPrivate }) {
  const { t } = useI18n();
  return (
    <div className="min-w-0 space-y-3 break-words">
      <p className="flex flex-wrap justify-between gap-2 font-medium">
        <span>{review.publicName ?? t("reviews.withdrawn")}</span>
        {review.rating !== null && <span>{review.rating} / 5</span>}
      </p>
      {review.body && <p className="whitespace-pre-wrap">{review.body}</p>}
      {review.services.length > 0 && (
        <p className="text-sm text-muted">
          {review.services.map((service) => service.name).join(" · ")}
        </p>
      )}
      {review.reply && (
        <div className="rounded-lg bg-sunken p-3">
          <p className="text-sm font-semibold">{t("reviews.replyBy")}</p>
          <p className="mt-1 whitespace-pre-wrap">{review.reply}</p>
        </div>
      )}
    </div>
  );
}
export function PublicReviews() {
  const { t, locale } = useI18n();
  const [before, setBefore] = useState<string>();
  const [serviceId, setServiceId] = useState("");
  const catalog = useQuery(servicesQuery);
  const query = useQuery({
    queryKey: ["reviews", "public", serviceId, before],
    queryFn: () => api().reviews.public({ before, serviceId: serviceId || undefined }),
    staleTime: 0,
  });
  return (
    <section aria-label={t("reviews.title")} className="space-y-6">
      <p className="max-w-prose text-muted">{t("reviews.publicLead")}</p>
      <div className="max-w-sm">
        <SelectField
          label={t("reviews.service")}
          value={serviceId}
          options={[
            { value: "", label: t("reviews.allServices") },
            ...(catalog.data ?? []).map((service) => ({ value: service.id, label: service.name })),
          ]}
          onChange={(value) => {
            setServiceId(value);
            setBefore(undefined);
          }}
        />
      </div>
      {query.isPending && <Skeleton className="h-32" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data && (
        <>
          {query.data.total > 0 && (
            <p className="font-display text-xl">
              {t("reviews.score", {
                average: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
                  query.data.average ?? 0,
                ),
                count: query.data.total,
              })}
            </p>
          )}
          {query.data.reviews.length === 0 && <EmptyState title={t("reviews.empty")} />}
          <ul className="grid gap-4 md:grid-cols-2">
            {query.data.reviews.map((review) => (
              <li key={review.id} className="min-w-0 rounded-xl border border-line bg-surface p-5">
                <ReviewContent review={review} />
                <p className="mt-4 text-sm text-muted">
                  {t("reviews.completed")} ·{" "}
                  {new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
                    new Date(review.publishedAt),
                  )}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            setBefore(undefined);
            void query.refetch();
          }}
        >
          {t("reviews.reload")}
        </Button>
        {query.data?.nextBefore && (
          <Button
            variant="secondary"
            onClick={() => setBefore(query.data?.nextBefore ?? undefined)}
          >
            {t("reviews.more")}
          </Button>
        )}
      </div>
    </section>
  );
}
export function OwnReviews() {
  const { t, locale, timeZone } = useI18n();
  const [before, setBefore] = useState<string>();
  const query = useQuery({
    queryKey: ["reviews", "own", before],
    queryFn: () => api().reviews.own(before),
    gcTime: 0,
  });
  const [selected, setSelected] = useState<{
    appointmentId: string;
    review: ReviewPrivate | null;
  }>();
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [withdraw, setWithdraw] = useState<ReviewPrivate>();
  const [pending, setPending] = useState(false);
  const [withdrawError, setWithdrawError] = useState<unknown>();
  const client = useQueryClient();
  const toast = useToast();
  const reload = async () => {
    await client.invalidateQueries({ queryKey: ["reviews"] });
  };
  const close = () => {
    setSelected(undefined);
    setDirty(false);
    setDiscard(false);
    void reload();
  };
  return (
    <div className="space-y-5">
      <UnsavedGuard dirty={dirty} />
      <p className="text-muted">{t("reviews.lead")}</p>
      {query.isPending && <Skeleton className="h-32" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.visits.length === 0 && <EmptyState title={t("reviews.ownEmpty")} />}
      <ul className="space-y-4">
        {query.data?.visits.map((visit) => (
          <li
            key={visit.appointmentId}
            className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-5"
          >
            <div>
              <p className="font-medium">
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "long",
                  timeStyle: "short",
                  timeZone,
                }).format(new Date(visit.startsAt))}
              </p>
              <p className="text-muted">
                {visit.services.map((service) => service.name).join(" · ")}
              </p>
            </div>
            {visit.review && (
              <>
                <p className="text-sm font-medium text-accent-text">
                  {t(`reviews.${visit.review.status}`)}
                </p>
                <ReviewContent review={visit.review} />
                {visit.review.moderationReason && (
                  <p className="text-sm text-muted">{visit.review.moderationReason}</p>
                )}
                {!visit.review.sourceEligible && (
                  <p className="text-sm text-muted">{t("reviews.sourceInvalid")}</p>
                )}
              </>
            )}
            <div className="flex flex-wrap gap-3">
              {(!visit.review || visit.review.sourceEligible) && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSelected(visit);
                    setDirty(false);
                  }}
                >
                  {t(visit.review ? "reviews.edit" : "reviews.write")}
                </Button>
              )}
              {visit.review && visit.review.status !== "withdrawn" && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    setWithdraw(visit.review ?? undefined);
                    setWithdrawError(undefined);
                  }}
                >
                  {t("reviews.withdraw")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            setBefore(undefined);
            void reload();
          }}
        >
          {t("reviews.reload")}
        </Button>
        {query.data?.nextBefore && (
          <Button
            variant="secondary"
            onClick={() => setBefore(query.data?.nextBefore ?? undefined)}
          >
            {t("reviews.moreVisits")}
          </Button>
        )}
      </div>
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) dirty ? setDiscard(true) : close();
        }}
        title={t(selected?.review ? "reviews.edit" : "reviews.write")}
        footer={
          <Button variant="secondary" onClick={() => (dirty ? setDiscard(true) : close())}>
            {t("reviews.close")}
          </Button>
        }
      >
        {selected && (
          <ReviewEditor
            key={`${selected.appointmentId}-${selected.review?.version ?? 0}`}
            {...selected}
            onDirtyChange={setDirty}
            onSaved={() => {
              close();
              toast.success(t("reviews.saved"));
            }}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("reviews.discard")}
        description={t("reviews.discardBody")}
        confirmLabel={t("reviews.discardConfirm")}
        cancelLabel={t("reviews.stay")}
        destructive
        onConfirm={close}
      />
      <ConfirmDialog
        open={Boolean(withdraw)}
        onOpenChange={(open) => {
          if (!open) setWithdraw(undefined);
        }}
        title={t("reviews.withdraw")}
        description={t("reviews.withdrawBody")}
        confirmLabel={t("reviews.withdraw")}
        cancelLabel={t("reviews.close")}
        destructive
        pending={pending}
        onConfirm={() => {
          if (!withdraw) return;
          setPending(true);
          setWithdrawError(undefined);
          void api()
            .reviews.withdraw(withdraw.id, withdraw.version)
            .then(() => {
              setWithdraw(undefined);
              void reload();
            })
            .catch(setWithdrawError)
            .finally(() => setPending(false));
        }}
      >
        {withdrawError !== undefined && <ReviewFailure error={withdrawError} />}
      </ConfirmDialog>
    </div>
  );
}
export function ReviewModeration() {
  const { t } = useI18n();
  const [status, setStatus] = useState("pending");
  const [before, setBefore] = useState<string>();
  const query = useQuery({
    queryKey: ["reviews", "admin", status, before],
    queryFn: () => api().reviews.admin({ status: status || undefined, before }),
    gcTime: 0,
  });
  const [selected, setSelected] = useState<ReviewPrivate>();
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const client = useQueryClient();
  const close = () => {
    setSelected(undefined);
    setDirty(false);
    setDiscard(false);
    void client.invalidateQueries({ queryKey: ["reviews"] });
  };
  return (
    <div className="space-y-5">
      <UnsavedGuard dirty={dirty} />
      <p className="text-muted">{t("reviews.lead")}</p>
      <div className="max-w-sm">
        <SelectField
          label={t("reviews.filter")}
          value={status}
          options={[
            { value: "", label: t("reviews.all") },
            ...(["pending", "published", "hidden", "withdrawn"] as const).map((value) => ({
              value,
              label: t(`reviews.${value}`),
            })),
          ]}
          onChange={(value) => {
            setStatus(value);
            setBefore(undefined);
          }}
        />
      </div>
      {query.isPending && <Skeleton className="h-32" />}
      {query.isError && <ErrorState error={query.error} onRetry={() => void query.refetch()} />}
      {query.data?.reviews.length === 0 && <EmptyState title={t("reviews.manageEmpty")} />}
      <ul className="grid gap-4 md:grid-cols-2">
        {query.data?.reviews.map((review) => (
          <li
            key={review.id}
            className="min-w-0 space-y-4 rounded-xl border border-line bg-surface p-5"
          >
            <p className="text-sm font-semibold text-accent-text">
              {t(`reviews.${review.status}`)}
            </p>
            <ReviewContent review={review} />
            {!review.sourceEligible && (
              <p className="text-sm text-muted">{t("reviews.sourceInvalid")}</p>
            )}
            {review.status !== "withdrawn" && (
              <Button variant="secondary" onClick={() => setSelected(review)}>
                {t("reviews.manage")}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button
          variant="ghost"
          onClick={() => {
            setBefore(undefined);
            void query.refetch();
          }}
        >
          {t("reviews.reload")}
        </Button>
        {query.data?.nextBefore && (
          <Button
            variant="secondary"
            onClick={() => setBefore(query.data?.nextBefore ?? undefined)}
          >
            {t("reviews.more")}
          </Button>
        )}
      </div>
      <Sheet
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) dirty ? setDiscard(true) : close();
        }}
        title={t("reviews.manage")}
        footer={
          <Button variant="secondary" onClick={() => (dirty ? setDiscard(true) : close())}>
            {t("reviews.close")}
          </Button>
        }
      >
        {selected && (
          <ModerateEditor
            key={`${selected.id}-${selected.version}`}
            review={selected}
            onDirtyChange={setDirty}
            onSaved={close}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title={t("reviews.discard")}
        description={t("reviews.discardBody")}
        confirmLabel={t("reviews.discardConfirm")}
        cancelLabel={t("reviews.stay")}
        destructive
        onConfirm={close}
      />
    </div>
  );
}
function ModerateEditor({
  review,
  onDirtyChange,
  onSaved,
}: {
  review: ReviewPrivate;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [reason, setReason] = useState(review.moderationReason ?? "");
  const [reply, setReply] = useState(review.reply ?? "");
  const mutation = useMutation({
    mutationFn: (kind: "publish" | "hide" | "reply") =>
      kind === "reply"
        ? api().reviews.reply(review.id, review.version, reply.trim() || null)
        : api().reviews.moderate(review.id, {
            version: review.version,
            status: kind === "publish" ? "published" : "hidden",
            ...(kind === "hide" ? { reason: reason.trim() } : {}),
          }),
    onSuccess: onSaved,
  });
  return (
    <div className="space-y-5">
      <ReviewContent review={review} />
      <p className="text-sm text-muted">{t("reviews.privacy")}</p>
      {!review.sourceEligible && <p className="text-muted">{t("reviews.sourceInvalid")}</p>}
      <TextAreaField
        label={t("reviews.reason")}
        maxLength={300}
        value={reason}
        disabled={mutation.isPending}
        onChange={(event) => {
          setReason(event.target.value);
          onDirtyChange(true);
          mutation.reset();
        }}
      />
      <div className="flex flex-wrap gap-3">
        <Button
          disabled={mutation.isPending || !review.sourceEligible}
          onClick={() => mutation.mutate("publish")}
        >
          {t("reviews.publish")}
        </Button>
        <Button
          variant="secondary"
          disabled={mutation.isPending || !reason.trim()}
          onClick={() => mutation.mutate("hide")}
        >
          {t("reviews.hide")}
        </Button>
      </div>
      {review.status === "published" && review.sourceEligible && (
        <>
          <TextAreaField
            label={t("reviews.reply")}
            hint={t("reviews.replyHint")}
            maxLength={1000}
            rows={4}
            value={reply}
            disabled={mutation.isPending}
            onChange={(event) => {
              setReply(event.target.value);
              onDirtyChange(true);
              mutation.reset();
            }}
          />
          <Button
            variant="secondary"
            disabled={mutation.isPending}
            onClick={() => mutation.mutate("reply")}
          >
            {t("reviews.replySave")}
          </Button>
        </>
      )}
      {mutation.isError && <ReviewFailure error={mutation.error} />}
    </div>
  );
}
