import {
  type BookingPromotionQuoteRequest,
  bookingPromotionQuoteRequestSchema,
} from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { promotionTimingConditions } from "~/lib/promotion-timing";

export function useBookingPromotion(
  selection: Omit<BookingPromotionQuoteRequest, "code"> | null,
  subjectKey: string,
) {
  const [code, setCode] = useState("");
  const input = selection
    ? bookingPromotionQuoteRequestSchema.safeParse({ ...selection, code })
    : null;
  const signature = JSON.stringify({ selection, subjectKey, code: code.trim().toUpperCase() });
  const preview = useMutation({
    mutationFn: async () => {
      if (!input?.success) throw new Error("Review a valid booking code and selection");
      return { signature, quote: await api().rewards.bookingQuote(input.data) };
    },
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
    review: () => preview.mutate(),
    resetReview: () => preview.reset(),
    clear: () => {
      setCode("");
      preview.reset();
    },
  };
}
export function BookingPromotionReview({
  state,
  disabled = false,
}: {
  state: ReturnType<typeof useBookingPromotion>;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const online = useOnline();
  return (
    <section
      aria-label={t("bookingPromotion.title")}
      className="min-w-0 space-y-3 rounded-xl border border-line bg-surface p-4"
    >
      <h2 className="text-heading">{t("bookingPromotion.title")}</h2>
      <p className="text-sm text-muted">{t("bookingPromotion.help")}</p>
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
