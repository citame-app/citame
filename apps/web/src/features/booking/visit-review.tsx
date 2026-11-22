import type { BookingPolicy, Service, VisitCreate } from "@sob/contracts";
import { LIMITS, needsFinalPrice } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { useStore } from "@tanstack/react-store";
import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClasses } from "~/components/ui/button";
import { TextAreaField } from "~/components/ui/select-field";
import { ErrorState, Skeleton } from "~/components/ui/states";
import { BookingForms, useBookingForms } from "~/features/intake/booking-forms";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatTime } from "~/lib/format";
import { InlineAuth } from "./auth-panel";
import { BookingFrame } from "./frame";
import { bookingTotals } from "./logic";
import { BookingPeakPrice, bookingPeakPriceKey, useBookingPeakPrice } from "./peak-price";
import { PriceTermsConsent, usePriceTerms } from "./price-terms";
import { BookingPromotionReview, useBookingPromotion } from "./promotion";
import { BookingPolicyConsent } from "./protection";
import { acceptedServiceQuotes } from "./quotes";
import { BookingRecoveryGuard } from "./recovery-guard";
import { totalPriceLabel } from "./service-price";
import { bookingActions, bookingStore } from "./store";
import { BookingSummary } from "./summary";
import type { BookingContext } from "./use-booking";
import { visitSegments } from "./visit-selection";

type ReviewedPart = { ready: boolean; total: number; payload: VisitCreate["parts"][number] };
function PartReview({
  services,
  staffId,
  startsAt,
  policy,
  subjectKey,
  enabled,
  disabled,
  onReview,
}: {
  services: Service[];
  staffId: string;
  startsAt: string;
  policy: BookingPolicy;
  subjectKey: string;
  enabled: boolean;
  disabled: boolean;
  onReview: (review: ReviewedPart) => void;
}) {
  const { t, locale } = useI18n();
  const intake = useBookingForms({ serviceIds: services.map((s) => s.id), enabled, subjectKey });
  const quotes = acceptedServiceQuotes(services);
  const finalPricePending = services.some((s) => needsFinalPrice(s.priceType));
  const priceTerms = usePriceTerms(services);
  const variablePrice = services.some((s) => s.priceType === "variable");
  const serviceIds = services.map((service) => service.id);
  const peak = useBookingPeakPrice(serviceIds, startsAt);
  const peakReady = peak.isSuccess && !peak.isFetching;
  const promotion = useBookingPromotion(
    enabled && peakReady && !finalPricePending && quotes
      ? { serviceIds, serviceQuotes: quotes, staffId, startsAt }
      : null,
    JSON.stringify([subjectKey, peak.data?.review]),
  );
  const subtotal = bookingTotals(
    services,
    services.map((s) => s.id),
  ).priceCents;
  const surchargeCents =
    peak.data?.services.reduce((sum, item) => sum + item.surchargeCents, 0) ?? 0;
  const total = promotion.quote?.newTotalCents ?? subtotal + surchargeCents;
  const [accepted, setAccepted] = useState<string | null>(null);
  const terms = JSON.stringify({
    version: policy.version,
    total,
    hash: promotion.payload?.reviewHash ?? null,
    peak: peak.data?.review,
  });
  const review: ReviewedPart = {
    ready:
      enabled &&
      peakReady &&
      intake.ready &&
      priceTerms.accepted &&
      promotion.ready &&
      (!policy.enabled ||
        ((!variablePrice || policy.depositKind === "fixed") && accepted === terms)),
    total,
    payload: {
      staffId,
      serviceIds,
      serviceQuotes: quotes,
      ...(peak.data?.review ? { peakPriceReview: peak.data.review } : {}),
      ...intake.payload,
      ...(priceTerms.required ? { priceTermsAccepted: true } : {}),
      ...(variablePrice && policy.enabled
        ? { protectionAcceptedDepositCents: policy.depositValue }
        : {}),
      ...(promotion.payload ? { promotion: promotion.payload } : {}),
      ...(policy.enabled
        ? { protectionAcceptedVersion: policy.version, protectionAcceptedTotalCents: total }
        : {}),
    },
  };
  const signature = JSON.stringify(review);
  useEffect(() => {
    onReview(JSON.parse(signature) as ReviewedPart);
  }, [signature, onReview]);
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-4">
      <BookingPeakPrice quote={peak} currency={services[0]?.currency ?? "EUR"} />
      <PriceTermsConsent state={priceTerms} disabled={disabled} />
      <p className="font-semibold">
        {totalPriceLabel(t, locale, services, total, services[0]?.currency ?? "EUR", true)}
      </p>
      {services
        .filter((s) => s.clientInstructions)
        .map((s) => (
          <div key={s.id}>
            <p className="text-sm font-semibold">
              {t("services.instructions")} · {s.name}
            </p>
            <p className="whitespace-pre-wrap text-sm text-muted">{s.clientInstructions}</p>
          </div>
        ))}
      <BookingForms state={intake} />
      {enabled && finalPricePending && (
        <p className="text-sm text-muted">{t("services.price.promotionLater")}</p>
      )}
      {enabled && !finalPricePending && (
        <details className="min-w-0">
          <summary className="cursor-pointer py-3 text-sm font-medium">
            {t("bookingPromotion.title")}
          </summary>
          <BookingPromotionReview state={promotion} disabled={disabled} />
        </details>
      )}
      <BookingPolicyConsent
        variablePrice={variablePrice}
        policy={policy}
        totalCents={total}
        acceptedVersion={accepted === terms ? policy.version : null}
        onAccept={(version) => setAccepted(version === policy.version ? terms : null)}
      />
    </fieldset>
  );
}

export function VisitReview({ booking }: { booking: BookingContext }) {
  const { t, locale } = useI18n();
  const { session } = useRouteContext({ from: "/book/review" });
  const navigate = useNavigate();
  const queries = useQueryClient();
  const { search, selectedServices, salon, totals } = booking;
  const parts = visitSegments(search.services, booking.catalog);
  const notes = useStore(bookingStore, (s) => s.notes);
  const subject = session?.user.id ?? "guest";
  const isClient = session?.user.role === "client";
  const [reviews, setReviews] = useState<Record<number, ReviewedPart>>({});
  const [uncertain, setUncertain] = useState(false);
  const packet = useRef<{ subject: string; body: VisitCreate } | null>(null);
  const intents = useRef(new Map<string, string>());
  const recoveryPending = useRef(false);
  const auth = useRef<HTMLElement>(null);
  const policy = useQuery({
    queryKey: ["booking-policy"],
    queryFn: () => api().bookingPolicy.get(),
    refetchInterval: 30000,
  });
  const request = {
    date: search.date ?? "",
    parts: parts.map((part, i) => ({
      serviceIds: part.map((s) => s.id),
      staffId: search.visitStaff?.[i],
    })),
  };
  const availability = useQuery({
    queryKey: ["visit-availability", "review", request],
    queryFn: () => api().visits.availability(request),
    enabled:
      Boolean(search.date && search.slot && search.visitStaff?.length === parts.length) &&
      !uncertain,
    refetchInterval: uncertain ? false : 30000,
  });
  const selected = availability.data?.slots.find(
    (s) =>
      s.startsAt === search.slot &&
      s.parts.length === parts.length &&
      s.parts.every((p, i) => p.staffId === search.visitStaff?.[i]),
  );
  const updateReview = useCallback(
    (index: number, review: ReviewedPart) =>
      setReviews((previous) => ({ ...previous, [index]: review })),
    [],
  );
  const ready = Boolean(
    isClient &&
      selected &&
      policy.isSuccess &&
      !availability.isError &&
      parts.length > 1 &&
      parts.every((_, i) => reviews[i]?.ready),
  );
  const total = parts.reduce(
    (sum, part, i) =>
      sum +
      (reviews[i]?.total ??
        bookingTotals(
          part,
          part.map((s) => s.id),
        ).priceCents),
    0,
  );
  const confirm = useMutation({
    mutationFn: () => {
      if (packet.current) {
        if (packet.current.subject !== subject || !isClient)
          throw new ApiError(
            "forbidden",
            403,
            "Sign in with the account that submitted this visit",
          );
        return api().visits.create(packet.current.body);
      }
      if (!ready || !search.slot) throw new Error("Review the complete visit");
      const body = {
        startsAt: search.slot,
        parts: parts.map((_, i) => {
          const review = reviews[i];
          if (!review?.ready) throw new Error("Review each treatment");
          return review.payload;
        }),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      };
      const fingerprint = JSON.stringify({ subject, body });
      const id = intents.current.get(fingerprint) ?? crypto.randomUUID();
      intents.current.set(fingerprint, id);
      packet.current = { subject, body: { id, ...body } };
      recoveryPending.current = true;
      return api().visits.create(packet.current.body);
    },
    onSuccess: (visit) => {
      packet.current = null;
      recoveryPending.current = false;
      setUncertain(false);
      bookingActions.setNotes("");
      void queries.invalidateQueries({ queryKey: ["appointments"] });
      void queries.invalidateQueries({ queryKey: ["availability"] });
      void queries.invalidateQueries({ queryKey: ["visit-availability"] });
      void navigate({ to: "/book/visit-confirmed/$visitId", params: { visitId: visit.id } });
    },
    onError: (error) => {
      const unknown =
        uncertain ||
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500);
      const stalePeakPrice = error instanceof ApiError && error.code === "peak_price_changed";
      setUncertain(unknown && !stalePeakPrice);
      if (unknown && !stalePeakPrice) return;
      packet.current = null;
      recoveryPending.current = false;
      if (error instanceof ApiError && error.code === "peak_price_changed") {
        void queries.invalidateQueries({ queryKey: bookingPeakPriceKey });
        return;
      }
      if (error instanceof ApiError && ["version_conflict", "not_found"].includes(error.code)) {
        void queries.invalidateQueries({ queryKey: ["services"] });
        booking.go("services", { services: search.services }, { replace: true });
      } else {
        void availability.refetch();
        void policy.refetch();
      }
    },
  });
  const report = useCallback(
    (i: number) => (review: ReviewedPart) => updateReview(i, review),
    [updateReview],
  );
  // Stable callbacks prevent a review update from re-triggering every child effect.
  const callbacks = useRef(new Map<number, (review: ReviewedPart) => void>());
  const callback = (i: number) => {
    let value = callbacks.current.get(i);
    if (!value) {
      value = report(i);
      callbacks.current.set(i, value);
    }
    return value;
  };
  return (
    <BookingFrame
      teamAccount={booking.teamAccount}
      step="review"
      search={search}
      title={t("services.visitReview")}
      lead={t("services.visitReviewLead")}
      summary={
        <BookingSummary
          revealHiddenPrices
          services={selectedServices}
          totals={{ ...totals, priceCents: total }}
          staffName={t("services.multiple")}
          slot={search.slot ? { startsAt: search.slot } : undefined}
          timeZone={salon.timezone}
          ctaLabel={session ? t("booking.cta.confirm") : t("booking.cta.signInToConfirm")}
          ctaLoading={confirm.isPending}
          ctaDisabled={Boolean(
            session && (!isClient || (uncertain ? packet.current?.subject !== subject : !ready)),
          )}
          onCta={() => {
            if (!session) auth.current?.scrollIntoView({ block: "center", behavior: "smooth" });
            else confirm.mutate();
          }}
        />
      }
    >
      <div className="space-y-5">
        <BookingRecoveryGuard pending={recoveryPending} />
        {uncertain && <p role="alert">{t("bookingPromotion.uncertain")}</p>}
        {confirm.error instanceof ApiError && confirm.error.code === "peak_price_changed" ? (
          <p role="alert">{t("bookingPeak.changed")}</p>
        ) : (
          confirm.isError && <ErrorState error={confirm.error} />
        )}
        {!session && <InlineAuth ref={auth} />}
        {session && !isClient && <p role="alert">{t("booking.review.staff.body")}</p>}
        {policy.isError && (
          <ErrorState error={policy.error} onRetry={() => void policy.refetch()} />
        )}
        {availability.isPending && !uncertain && <Skeleton className="h-24" />}
        {availability.isError && (
          <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />
        )}
        {!selected && availability.isSuccess && !uncertain && (
          <p role="alert">{t("services.visitNoTimes")}</p>
        )}
        {policy.data &&
          selected &&
          parts.map((part, i) => {
            const visitPart = selected.parts[i];
            if (!visitPart) return null;
            return (
              <section
                key={`${subject}:${part[0]?.id}`}
                className="min-w-0 space-y-4 rounded-lg border border-line p-4"
              >
                <h2 className="text-heading">{part.map((s) => s.name).join(" + ")}</h2>
                <p className="text-sm text-muted">
                  {formatTime(visitPart.startsAt, salon.timezone, locale)} ·{" "}
                  {booking.staff.find((s) => s.id === selected.parts[i]?.staffId)?.displayName}
                </p>
                <PartReview
                  services={part}
                  staffId={visitPart.staffId}
                  startsAt={visitPart.startsAt}
                  policy={policy.data}
                  subjectKey={subject}
                  enabled={Boolean(isClient)}
                  disabled={confirm.isPending || uncertain}
                  onReview={callback(i)}
                />
              </section>
            );
          })}
        {policy.data?.enabled && (
          <p className="text-sm text-muted">{t("services.visitPayments")}</p>
        )}
        <TextAreaField
          label={t("booking.review.notes")}
          value={notes}
          maxLength={LIMITS.notes}
          disabled={confirm.isPending || uncertain}
          onChange={(e) => bookingActions.setNotes(e.target.value)}
        />
        <Link to="/account" className={buttonClasses({ variant: "secondary" })}>
          {t("services.visitManage")}
        </Link>
      </div>
    </BookingFrame>
  );
}
