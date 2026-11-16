import type { Appointment, WaitlistEntry } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button, buttonClasses } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { SelectField } from "~/components/ui/select-field";
import { Sheet } from "~/components/ui/sheet";
import { EmptyState, ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useNow } from "~/features/admin/use-now";
import { BookingProtectionNotice } from "~/features/booking/protection";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatDateLong, formatMoney, formatTime, localDateOf } from "~/lib/format";
import { type JoinFormProps, WaitlistJoinForm } from "./join-form";
import { WaitlistOfferReview } from "./offer-review";
import { WaitlistPolicyForm } from "./policy-form";

const states = ["waiting", "offered", "booked", "cancelled", "expired", "unavailable"] as const;
export function WaitlistView({
  mode,
  role,
  accessPreset,
  ownStaffId,
  clientId,
  initialServices,
  initialStaff,
  initialDate,
}: Omit<JoinFormProps, "onJoined"> & { clientId?: string | null }) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const toast = useToast();
  const now = useNow(15000);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<"" | (typeof states)[number]>("");
  const [joining, setJoining] = useState(false);
  const [review, setReview] = useState<WaitlistEntry | null>(null);
  const [cancelling, setCancelling] = useState<WaitlistEntry | null>(null);
  const [booked, setBooked] = useState<Appointment | null>(null);
  const query = useQuery({
    queryKey: ["waitlist", mode, clientId ?? ownStaffId ?? "operator", page, state],
    queryFn: () => api().waitlist.list(mode, { page, pageSize: 10, ...(state ? { state } : {}) }),
    refetchInterval: online ? 15000 : false,
  });
  const invalidate = () => {
    void queries.invalidateQueries({ queryKey: ["waitlist"] });
    void queries.invalidateQueries({ queryKey: ["availability"] });
  };
  const cancel = useMutation({
    mutationFn: (entry: WaitlistEntry) => api().waitlist.cancel(mode, entry.id, entry.version),
    onSuccess: () => {
      setCancelling(null);
      toast.success(t("waitlist.cancelled"));
      invalidate();
    },
  });
  const decline = useMutation({
    mutationFn: (entry: WaitlistEntry) => {
      if (!entry.offer) throw new Error("Missing offer");
      return api().waitlist.decline(mode, entry.id, {
        version: entry.version,
        offerId: entry.offer.id,
        requeue: true,
      });
    },
    onSuccess: () => {
      toast.success(t("waitlist.declined"));
      invalidate();
    },
  });
  if (query.isPending) return <Skeleton className="h-52" />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  return (
    <section aria-label={t("waitlist.title")} className="min-w-0 space-y-6">
      {mode === "admin" && role === "owner" && <WaitlistPolicyForm initial={query.data.policy} />}
      <p className="text-sm text-muted">{t("waitlist.help")}</p>
      {booked && (
        <div role="status" className="space-y-3 rounded-xl border border-line bg-surface p-4">
          <p className="font-medium text-success-fg">{t("waitlist.accepted")}</p>
          {booked.protection && (
            <BookingProtectionNotice protection={booked.protection} role={role} mode={mode} />
          )}
          <BookingLink
            mode={mode}
            appointmentId={booked.id}
            startsAt={booked.startsAt}
            staffId={booked.staffId}
          />
        </div>
      )}
      {!query.data.policy.enabled && (
        <p className="rounded-lg bg-sunken p-4 text-sm">{t("waitlist.paused")}</p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <SelectField
          className="min-w-0 w-full sm:w-80"
          label={t("waitlist.filter")}
          value={state}
          onChange={(value) => {
            setState(value as typeof state);
            setPage(1);
          }}
          options={[
            { value: "", label: t("waitlist.all") },
            ...states.map((s) => ({ value: s, label: t(`waitlist.state.${s}`) })),
          ]}
        />
        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            loading={query.isFetching}
            disabled={!online}
            onClick={() => void query.refetch()}
          >
            {t("waitlist.refresh")}
          </Button>
          {query.data.policy.enabled && !joining && (
            <Button onClick={() => setJoining(true)} className="max-w-full whitespace-normal!">
              {t("waitlist.join")}
            </Button>
          )}
        </div>
      </div>
      {joining && (
        <div className="space-y-3">
          <WaitlistJoinForm
            mode={mode}
            role={role}
            accessPreset={accessPreset}
            ownStaffId={ownStaffId}
            initialServices={initialServices}
            initialStaff={initialStaff}
            initialDate={initialDate}
            onJoined={() => setJoining(false)}
          />
          <Button variant="ghost" onClick={() => setJoining(false)}>
            {t("admin.cancel")}
          </Button>
        </div>
      )}
      {cancel.isError && <ErrorState error={cancel.error} />}{" "}
      {decline.isError && <ErrorState error={decline.error} />}
      {query.data.entries.length === 0 ? (
        <EmptyState title={t("waitlist.empty")} />
      ) : (
        <ul className="grid min-w-0 grid-cols-1 gap-4">
          {query.data.entries.map((entry) => {
            const expired = entry.offer && Date.parse(entry.offer.expiresAt) <= now.getTime();
            return (
              <li
                key={entry.id}
                className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4 sm:p-5"
                data-waitlist-id={entry.id}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="min-w-0 break-words text-heading">
                    {entry.clientName ? `${entry.clientName} · ` : ""}
                    {entry.serviceNames.join(" + ")}
                  </h2>
                  <p className="text-sm font-medium text-accent-text">
                    {t(`waitlist.state.${entry.state}`)}
                  </p>
                </div>
                <p className="text-sm text-muted">
                  {entry.fromDate === entry.toDate
                    ? t("waitlist.windowSingle", {
                        date: formatDateLong(entry.fromDate, locale),
                        start: entry.fromTime,
                        end: entry.toTime,
                      })
                    : t("waitlist.window", {
                        from: formatDateLong(entry.fromDate, locale),
                        to: formatDateLong(entry.toDate, locale),
                        start: entry.fromTime,
                        end: entry.toTime,
                      })}
                </p>
                {entry.offer && (
                  <div className="space-y-2 rounded-lg bg-sunken p-3">
                    <p className="text-sm text-muted">
                      {t("waitlist.professional", {
                        name: entry.offer.staffName ?? t("account.staffFallback"),
                      })}
                    </p>
                    <p className="font-medium">
                      {formatDateLong(localDateOf(entry.offer.startsAt, entry.timezone), locale)} ·{" "}
                      {formatTime(entry.offer.startsAt, entry.timezone, locale)}
                    </p>
                    <p>
                      {t("waitlist.price", {
                        price: formatMoney(entry.offer.priceCents, entry.offer.currency, locale),
                      })}
                    </p>
                    <p className="text-sm">
                      {expired
                        ? t("waitlist.expired")
                        : t("waitlist.expires", {
                            date: new Intl.DateTimeFormat(locale, {
                              dateStyle: "medium",
                              timeStyle: "short",
                              timeZone: entry.timezone,
                            }).format(new Date(entry.offer.expiresAt)),
                          })}
                    </p>
                    <p className="text-xs text-muted">{t("waitlist.cooldown")}</p>
                    <div className="flex flex-wrap gap-3">
                      <Button
                        disabled={
                          !online || Boolean(expired) || cancel.isPending || decline.isPending
                        }
                        onClick={() => setReview(entry)}
                        className="max-w-full whitespace-normal!"
                      >
                        {t("waitlist.review")}
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={
                          !entry.canManage || !online || cancel.isPending || decline.isPending
                        }
                        onClick={() => decline.mutate(entry)}
                        className="max-w-full whitespace-normal!"
                      >
                        {t("waitlist.decline")}
                      </Button>
                    </div>
                  </div>
                )}
                {entry.bookedAppointment && (
                  <BookingLink
                    mode={mode}
                    appointmentId={entry.bookedAppointment.id}
                    startsAt={entry.bookedAppointment.startsAt}
                    staffId={entry.bookedAppointment.staffId}
                  />
                )}
                {entry.canManage && ["waiting", "offered"].includes(entry.state) && (
                  <Button
                    variant="ghost"
                    disabled={!entry.canManage || !online || cancel.isPending || decline.isPending}
                    onClick={() => {
                      cancel.reset();
                      setCancelling(entry);
                    }}
                    className="max-w-full whitespace-normal!"
                  >
                    {t("waitlist.cancel")}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {t("waitlist.page", { page, count: query.data.total })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((v) => v - 1)}>
            {t("waitlist.previous")}
          </Button>
          <Button
            variant="secondary"
            disabled={page * query.data.pageSize >= query.data.total}
            onClick={() => setPage((v) => v + 1)}
          >
            {t("waitlist.next")}
          </Button>
        </div>
      </div>
      <Sheet
        open={Boolean(review)}
        onOpenChange={(open) => !open && setReview(null)}
        title={t("waitlist.offerTitle")}
        size="lg"
      >
        {review && (
          <WaitlistOfferReview
            key={`${review.id}:${review.version}`}
            entry={review}
            mode={mode}
            role={role}
            accessPreset={accessPreset}
            onBooked={(a) => {
              setBooked(a);
              setReview(null);
            }}
          />
        )}
      </Sheet>
      <ConfirmDialog
        open={Boolean(cancelling)}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t("waitlist.cancelTitle")}
        description={t("waitlist.cancelBody")}
        confirmLabel={t("waitlist.cancelConfirm")}
        cancelLabel={t("account.cancel.keep")}
        destructive
        pending={cancel.isPending}
        onConfirm={() => cancelling && cancel.mutate(cancelling)}
      />
    </section>
  );
}
function BookingLink({
  mode,
  appointmentId,
  startsAt,
  staffId,
}: {
  mode: CommerceMode;
  appointmentId: string;
  startsAt?: string;
  staffId?: string;
}) {
  const { t, timeZone } = useI18n();
  return mode === "client" ? (
    <Link
      to="/account"
      search={{ highlight: appointmentId }}
      className={buttonClasses({ variant: "secondary" })}
    >
      {t("waitlist.viewBooking")}
    </Link>
  ) : (
    <Link
      to="/admin/calendar"
      search={{
        view: "day",
        ...(startsAt ? { date: localDateOf(startsAt, timeZone) } : {}),
        ...(staffId ? { staff: staffId } : {}),
      }}
      className={buttonClasses({ variant: "secondary" })}
    >
      {t("waitlist.viewBooking")}
    </Link>
  );
}
