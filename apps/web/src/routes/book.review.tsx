import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useEffect, useRef, useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { InlineAuth } from "~/features/booking/auth-panel";
import { BookingFrame } from "~/features/booking/frame";
import { createBookingIntent } from "~/features/booking/intent";
import { BookingPromotionReview, useBookingPromotion } from "~/features/booking/promotion";
import { BookingPolicyConsent } from "~/features/booking/protection";
import { acceptedServiceQuotes } from "~/features/booking/quotes";
import { BookingRecoveryGuard } from "~/features/booking/recovery-guard";
import {
  canEnterStep,
  parseBookingSearch,
  serializeBookingSearch,
} from "~/features/booking/search";
import { bookingActions, bookingStore } from "~/features/booking/store";
import { BookingSummary } from "~/features/booking/summary";
import { useBooking } from "~/features/booking/use-booking";
import { BookingForms, useBookingForms } from "~/features/intake/booking-forms";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { bootstrapQuery } from "~/server/request";

export const Route = createFileRoute("/book/review")({
  beforeLoad: ({ search }) => {
    const parsed = parseBookingSearch(search);
    if (!canEnterStep(parsed, "review")) {
      throw redirect({
        to:
          parsed.services.length === 0
            ? "/book"
            : parsed.staff
              ? "/book/time"
              : "/book/professional",
        search: serializeBookingSearch(parsed),
        replace: true,
      });
    }
  },
  component: ReviewStep,
});

function ReviewStep() {
  const { t } = useI18n();
  const toast = useToast();
  const booking = useBooking();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { session } = Route.useRouteContext();
  const notes = useStore(bookingStore, (state) => state.notes);
  const authRef = useRef<HTMLElement>(null);
  const { search, selectedServices, totals, salon } = booking;
  const [acceptedTotal, setAcceptedTotal] = useState<number | null>(null);
  const [acceptedVersion, setAcceptedVersion] = useState<number | null>(null);
  const [intent] = useState(() => createBookingIntent());
  const [uncertain, setUncertain] = useState(false);
  const packet = useRef<Parameters<ReturnType<typeof api>["appointments"]["create"]>[0] | null>(
    null,
  );
  const recoveryPending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isClient = session?.user.role === "client";
  const isStaff = session !== null && !isClient;
  const quotes = acceptedServiceQuotes(selectedServices);
  const promotion = useBookingPromotion(
    isClient && quotes && search.slot && search.slotStaff
      ? {
          staffId: search.slotStaff,
          serviceIds: search.services,
          serviceQuotes: quotes,
          startsAt: search.slot,
        }
      : null,
    session?.user.id ?? "guest",
  );
  const reviewTotal = promotion.quote?.newTotalCents ?? totals.priceCents;
  const [acceptedPromotionHash, setAcceptedPromotionHash] = useState<string | null>(null);

  const policy = useQuery({
    queryKey: ["booking-policy"],
    queryFn: () => api().bookingPolicy.get(),
    refetchInterval: 30000,
  });
  const policyAccepted =
    policy.isSuccess &&
    (!policy.data.enabled ||
      (acceptedVersion === policy.data.version &&
        acceptedTotal === reviewTotal &&
        acceptedPromotionHash === (promotion.payload?.reviewHash ?? null)));

  useEffect(() => {
    bookingActions.restore();
  }, []);

  const intake = useBookingForms({
    serviceIds: search.services,
    enabled: Boolean(isClient),
    subjectKey: session?.user.id ?? "guest",
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (packet.current) return api().appointments.create(packet.current);
      if (!promotion.ready) throw new Error("Review the current promotion");
      if (!policyAccepted) throw new Error("Review current booking policy");
      if (!intake.ready) throw new Error("Complete the current forms");
      if (!search.slot || !search.slotStaff) throw new Error("incomplete booking");
      const request = {
        ...intake.payload,
        ...(promotion.payload ? { promotion: promotion.payload } : {}),
        staffId: search.slotStaff,
        professionalPreference: search.staff === "any" ? ("any" as const) : ("specific" as const),
        serviceIds: search.services,
        serviceQuotes: acceptedServiceQuotes(selectedServices),
        startsAt: search.slot,
        notes: notes.trim() || undefined,
        protectionAcceptedTotalCents: acceptedTotal ?? undefined,
        protectionAcceptedVersion: policy.data?.enabled
          ? (acceptedVersion ?? undefined)
          : undefined,
      };
      packet.current = { ...request, id: intent(request) };
      recoveryPending.current = true;
      return api().appointments.create(packet.current);
    },
    onSuccess: (appointment) => {
      packet.current = null;
      recoveryPending.current = false;
      if (!mounted.current) return;
      setUncertain(false);
      bookingActions.recordBooked(appointment);
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      void navigate({
        to: "/book/confirmed/$appointmentId",
        params: { appointmentId: appointment.id },
      });
    },
    onError: (error) => {
      if (!mounted.current) return;
      const unknown =
        uncertain ||
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500);
      setUncertain(unknown);
      if (unknown) return;
      packet.current = null;
      recoveryPending.current = false;
      if (error instanceof ApiError && error.code === "online_booking_paused") {
        void queryClient.invalidateQueries({ queryKey: ["salon"] });
        toast.error(t("booking.paused.title"));
        return;
      }
      if (error instanceof ApiError && error.code === "booking_promotion_changed") {
        promotion.resetReview();
        setAcceptedVersion(null);
        setAcceptedTotal(null);
        setAcceptedPromotionHash(null);
        toast.error(t("bookingPromotion.changed"));
        return;
      }
      if (error instanceof ApiError && error.code === "intake_required") {
        void intake.refresh();
        toast.error(t("intake.changed"));
        return;
      }
      if (error instanceof ApiError && error.code === "booking_intent_conflict") {
        toast.error(t("intake.conflict"));
        return;
      }
      if (
        error instanceof ApiError &&
        (error.code === "version_conflict" || error.code === "not_found")
      ) {
        void queryClient.invalidateQueries({ queryKey: ["services"] });
        void queryClient.invalidateQueries({ queryKey: ["staff"] });
        void queryClient.invalidateQueries({ queryKey: ["availability"] });
        toast.error(t("booking.review.catalogChanged"));
        booking.go("services", { services: search.services }, { replace: true });
        return;
      }
      if (error instanceof ApiError && error.code === "invalid_state") {
        setAcceptedVersion(null);
        setAcceptedTotal(null);
        void policy.refetch();
        void queryClient.invalidateQueries({ queryKey: ["services"] });
      }
      if (
        error instanceof ApiError &&
        (error.code === "slot_taken" || error.code === "slot_unavailable")
      ) {
        // Someone else got there first: keep every other choice, refresh the times, explain.
        if (search.slot) bookingActions.markSlotTaken(search.slot);
        void queryClient.invalidateQueries({ queryKey: ["availability"] });
        booking.go("time", { ...search, slot: undefined, slotStaff: undefined }, { replace: true });
        return;
      }
      if (error instanceof ApiError && error.code === "unauthorized") {
        queryClient.setQueryData(bootstrapQuery.queryKey, (previous) =>
          previous ? { ...previous, session: null } : previous,
        );
        toast.error(t("booking.review.sessionExpired"));
        return;
      }
      toast.error(t("booking.review.failed"));
    },
  });

  const intakeSelection = JSON.stringify(intake.payload);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only a stale-form error when the reviewed form selection changes
  useEffect(() => {
    if (confirm.error instanceof ApiError && confirm.error.code === "intake_required")
      confirm.reset();
  }, [intakeSelection]);

  function onCta() {
    if (!session) {
      authRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      authRef.current?.focus();
      return;
    }
    if (uncertain || (policyAccepted && intake.ready && promotion.ready)) confirm.mutate();
  }

  return (
    <BookingFrame
      step="review"
      search={search}
      title={t("booking.review.title")}
      lead={t("booking.review.lead")}
      summary={
        <BookingSummary
          services={selectedServices}
          totals={{ ...totals, priceCents: reviewTotal }}
          staffName={booking.staffName}
          slot={search.slot ? { startsAt: search.slot } : undefined}
          timeZone={salon.timezone}
          ctaLabel={session ? t("booking.cta.confirm") : t("booking.cta.signInToConfirm")}
          ctaLoading={confirm.isPending}
          ctaDisabled={
            isStaff || (!uncertain && (!policyAccepted || !intake.ready || !promotion.ready))
          }
          onCta={onCta}
        />
      }
    >
      <div className="space-y-6">
        <BookingRecoveryGuard pending={recoveryPending} />
        {uncertain && (
          <div className="space-y-3">
            <p role="alert">{t("bookingPromotion.uncertain")}</p>
            <Link
              to="/account"
              className={buttonClasses({ variant: "secondary" })}
              onClick={() => {
                recoveryPending.current = false;
              }}
            >
              {t("bookingPromotion.checkAppointments")}
            </Link>
          </div>
        )}
        {confirm.error instanceof ApiError &&
          confirm.error.code === "booking_promotion_changed" &&
          !promotion.quote && <p role="alert">{t("bookingPromotion.changed")}</p>}
        <fieldset disabled={confirm.isPending || uncertain} className="min-w-0">
          <BookingForms state={intake} />
        </fieldset>
        {isClient && (
          <BookingPromotionReview state={promotion} disabled={confirm.isPending || uncertain} />
        )}
        {policy.isError && (
          <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
        )}
        {policy.data && (
          <fieldset disabled={confirm.isPending || uncertain} className="min-w-0">
            <BookingPolicyConsent
              policy={policy.data}
              totalCents={reviewTotal}
              acceptedVersion={
                acceptedTotal === reviewTotal &&
                acceptedPromotionHash === (promotion.payload?.reviewHash ?? null)
                  ? acceptedVersion
                  : null
              }
              onAccept={(version) => {
                setAcceptedVersion(version);
                setAcceptedTotal(reviewTotal);
                setAcceptedPromotionHash(promotion.payload?.reviewHash ?? null);
              }}
            />
          </fieldset>
        )}
        {confirm.isError &&
          !(
            confirm.error instanceof ApiError &&
            (confirm.error.code === "unauthorized" ||
              confirm.error.code === "booking_promotion_changed")
          ) && <ErrorState error={confirm.error} onRetry={() => confirm.mutate()} />}

        {isStaff && (
          <div
            role="note"
            className="rounded-xl border border-line bg-warning-soft p-5 text-warning-fg"
          >
            <p className="font-display text-lg font-semibold">{t("booking.review.staff.title")}</p>
            <p className="mt-1">{t("booking.review.staff.body")}</p>
            <Link
              to="/admin/calendar"
              className={`${buttonClasses({ variant: "secondary" })} mt-4`}
            >
              {t("booking.review.staff.link")}
            </Link>
          </div>
        )}

        <div>
          <label htmlFor="booking-notes" className="mb-1.5 block text-sm font-medium">
            {t("booking.review.notes")}
          </label>
          <textarea
            id="booking-notes"
            disabled={confirm.isPending || uncertain}
            rows={3}
            maxLength={500}
            value={notes}
            onChange={(event) => bookingActions.setNotes(event.target.value)}
            aria-describedby="booking-notes-hint"
            className="block w-full rounded-md border border-line-strong bg-surface px-3.5 py-2.5 text-base text-fg placeholder:text-muted/70 hover:border-fg/60 focus:border-ring"
          />
          <p id="booking-notes-hint" className="mt-1.5 text-sm text-muted">
            {t("booking.review.notesHint")}
          </p>
        </div>

        {!session && <InlineAuth ref={authRef} />}
      </div>
    </BookingFrame>
  );
}
