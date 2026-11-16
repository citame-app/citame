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
import { BookingPolicyConsent } from "~/features/booking/protection";
import { acceptedServiceQuotes } from "~/features/booking/quotes";
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
import { ApiError } from "~/lib/api/client";
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
  const policy = useQuery({
    queryKey: ["booking-policy"],
    queryFn: () => api().bookingPolicy.get(),
    refetchInterval: 30000,
  });
  const policyAccepted =
    policy.isSuccess &&
    (!policy.data.enabled ||
      (acceptedVersion === policy.data.version && acceptedTotal === totals.priceCents));

  useEffect(() => {
    bookingActions.restore();
  }, []);

  const isClient = session?.user.role === "client";
  const isStaff = session !== null && !isClient;
  const intake = useBookingForms({
    serviceIds: search.services,
    enabled: Boolean(isClient),
    subjectKey: session?.user.id ?? "guest",
  });

  const confirm = useMutation({
    mutationFn: () => {
      if (!policyAccepted) throw new Error("Review current booking policy");
      if (!intake.ready) throw new Error("Complete the current forms");
      if (!search.slot || !search.slotStaff) throw new Error("incomplete booking");
      const request = {
        ...intake.payload,
        staffId: search.slotStaff,
        serviceIds: search.services,
        serviceQuotes: acceptedServiceQuotes(selectedServices),
        startsAt: search.slot,
        notes: notes.trim() || undefined,
        protectionAcceptedTotalCents: acceptedTotal ?? undefined,
        protectionAcceptedVersion: policy.data?.enabled
          ? (acceptedVersion ?? undefined)
          : undefined,
      };
      return api().appointments.create({ ...request, id: intent(request) });
    },
    onSuccess: (appointment) => {
      bookingActions.recordBooked(appointment);
      void queryClient.invalidateQueries({ queryKey: ["appointments"] });
      void queryClient.invalidateQueries({ queryKey: ["availability"] });
      void navigate({
        to: "/book/confirmed/$appointmentId",
        params: { appointmentId: appointment.id },
      });
    },
    onError: (error) => {
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
    if (policyAccepted && intake.ready) confirm.mutate();
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
          totals={totals}
          staffName={booking.staffName}
          slot={search.slot ? { startsAt: search.slot } : undefined}
          timeZone={salon.timezone}
          ctaLabel={session ? t("booking.cta.confirm") : t("booking.cta.signInToConfirm")}
          ctaLoading={confirm.isPending}
          ctaDisabled={isStaff || !policyAccepted || !intake.ready}
          onCta={onCta}
        />
      }
    >
      <div className="space-y-6">
        <BookingForms state={intake} />
        {policy.isError && (
          <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
        )}
        {policy.data && (
          <BookingPolicyConsent
            policy={policy.data}
            totalCents={totals.priceCents}
            acceptedVersion={acceptedTotal === totals.priceCents ? acceptedVersion : null}
            onAccept={(version) => {
              setAcceptedVersion(version);
              setAcceptedTotal(totals.priceCents);
            }}
          />
        )}
        {confirm.isError &&
          !(confirm.error instanceof ApiError && confirm.error.code === "unauthorized") && (
            <ErrorState error={confirm.error} onRetry={() => confirm.mutate()} />
          )}

        {isStaff && (
          <div
            role="note"
            className="rounded-xl border border-line bg-warning-soft p-5 text-warning-fg"
          >
            <p className="font-display text-lg font-semibold">{t("booking.review.staff.title")}</p>
            <p className="mt-1">{t("booking.review.staff.body")}</p>
            <Link to="/admin" className={`${buttonClasses({ variant: "secondary" })} mt-4`}>
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
