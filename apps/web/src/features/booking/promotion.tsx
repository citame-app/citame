import {
  type BookingPromotionQuoteRequest,
  bookingPromotionQuoteRequestSchema,
  type Service,
} from "@sob/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { promotionTimingConditions } from "~/lib/promotion-timing";
import { FlashOfferDetails } from "./flash-storefront";

export function useBookingPromotion(
  selection: Omit<BookingPromotionQuoteRequest, "code"> | null,
  subjectKey: string,
) {
  const [code, setCode] = useState("");
  const input = selection
    ? bookingPromotionQuoteRequestSchema.safeParse({ ...selection, code })
    : null;
  const signatureFor = (value: string) =>
    JSON.stringify({ selection, subjectKey, code: value.trim().toUpperCase() });
  const signature = signatureFor(code);
  const preview = useMutation({
    mutationFn: async (request: { input: BookingPromotionQuoteRequest; signature: string }) => ({
      signature: request.signature,
      quote: await api().rewards.bookingQuote(request.input),
    }),
  });
  const quote =
    !preview.isPending && preview.data?.signature === signature ? preview.data.quote : null;
  return {
    code,
    setCode,
    quote,
    ready: !code.trim() || Boolean(quote),
    valid: Boolean(input?.success),
    pending: preview.isPending,
    error: preview.error,
    payload: quote ? { code: code.trim().toUpperCase(), reviewHash: quote.reviewHash } : undefined,
    canReview: selection !== null,
    review: (offerCode = code) => {
      if (!selection) return;
      const request = bookingPromotionQuoteRequestSchema.safeParse({
        ...selection,
        code: offerCode,
      });
      if (!request.success) return;
      setCode(offerCode);
      preview.mutate({ input: request.data, signature: signatureFor(offerCode) });
    },
    resetReview: () => preview.reset(),
    clear: () => {
      setCode("");
      preview.reset();
    },
  };
}
export function BookingPromotionReview({
  state,
  services,
  disabled = false,
}: {
  state: ReturnType<typeof useBookingPromotion>;
  services: Pick<Service, "id" | "priceCents" | "currency">[];
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  const offerServiceIds = services.every(({ currency }) => currency === "EUR")
    ? services.filter(({ priceCents }) => priceCents > 0).map(({ id }) => id)
    : [];
  const canShowOffers = state.canReview && online && offerServiceIds.length > 0;
  const flash = useQuery({
    queryKey: ["public-flash-offers"],
    queryFn: ({ signal }) => api().rewards.flashOffers(signal),
    refetchInterval: 30000,
    enabled: canShowOffers,
  });
  const offers =
    flash.isSuccess && canShowOffers
      ? flash.data.offers.filter(
          (offer) =>
            offer.allServices || offer.services.some(({ id }) => offerServiceIds.includes(id)),
        )
      : [];
  return (
    <section
      aria-label={t("bookingPromotion.title")}
      className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-heading">{t("bookingPromotion.title")}</h2>
      <p className="text-sm text-muted">{t("bookingPromotion.help")}</p>
      {!!offers.length && (
        <ul className="space-y-2" aria-label={t("flashOffers.title")}>
          {offers.map((offer) => (
            <li key={offer.id} className="rounded-lg border border-line bg-sunken p-3">
              <article className="space-y-2">
                <h3 className="break-words font-semibold">{offer.name}</h3>
                <FlashOfferDetails offer={offer} />
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || state.pending}
                  aria-label={t("flashOffers.reviewNamed", { name: offer.name })}
                  onClick={() => state.review(offer.code)}
                >
                  {t("bookingPromotion.review")}
                </Button>
              </article>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (state.valid && !disabled) state.review();
        }}
      >
        <fieldset disabled={disabled} className="min-w-0 space-y-3">
          <TextField
            label={t("bookingPromotion.code")}
            value={state.code}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => state.setCode(e.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              variant="secondary"
              disabled={!online || !state.valid || state.pending}
            >
              {t("bookingPromotion.review")}
            </Button>
            {state.code && (
              <Button type="button" variant="ghost" onClick={state.clear}>
                {t("bookingPromotion.remove")}
              </Button>
            )}
          </div>
        </fieldset>
      </form>
      {state.error && <p role="alert">{t("bookingPromotion.failed")}</p>}
      {state.code.trim() && !state.quote && !state.error && (
        <p role="status" className="text-sm text-muted">
          {t("bookingPromotion.required")}
        </p>
      )}
      {state.quote && (
        <div className="space-y-2 border-t border-line pt-3">
          <p className="font-semibold [overflow-wrap:anywhere]">{state.quote.name}</p>
          {state.quote.subtotalCents > state.quote.currentTotalCents && (
            <p className="text-sm text-muted">
              {t("bookingPromotion.existingBenefits", {
                amount: formatMoney(
                  state.quote.subtotalCents - state.quote.currentTotalCents,
                  "EUR",
                  locale,
                ),
              })}
            </p>
          )}
          <p role="status">
            {t("bookingPromotion.quote", {
              amount: formatMoney(state.quote.discountCents, "EUR", locale),
              total: formatMoney(state.quote.newTotalCents, "EUR", locale),
            })}
          </p>
          {state.quote.appointmentTiming &&
            promotionTimingConditions(
              state.quote.appointmentTiming.timing,
              state.quote.appointmentTiming.timeZone,
              locale,
            ).map((text) => (
              <p className="text-sm text-muted" key={text}>
                {text}
              </p>
            ))}
          <p className="text-sm text-muted">{t("bookingPromotion.reservation")}</p>
        </div>
      )}
    </section>
  );
}
