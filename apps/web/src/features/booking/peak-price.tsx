import { useQuery } from "@tanstack/react-query";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";

export const bookingPeakPriceKey = ["booking-peak-price"] as const;

export function useBookingPeakPrice(
  serviceIds: string[],
  startsAt: string | undefined,
  team = false,
  combinationId?: string,
) {
  return useQuery({
    queryKey: [...bookingPeakPriceKey, startsAt, serviceIds, team, combinationId ?? null],
    enabled: Boolean(startsAt && serviceIds.length),
    queryFn: ({ signal }) =>
      api().peakPrice(serviceIds, startsAt ?? "", signal, team, combinationId),
    refetchOnWindowFocus: false,
  });
}

export function BookingPeakPrice({
  quote,
  currency,
}: {
  quote: ReturnType<typeof useBookingPeakPrice>;
  currency: string;
}) {
  const { t, locale } = useI18n();
  const surcharge = quote.data?.services.reduce((sum, line) => sum + line.surchargeCents, 0) ?? 0;
  return (
    <>
      <div role="status">
        {quote.data?.combination && (
          <p className="rounded-lg border border-line bg-surface p-3 text-sm">
            {t("combinations.fixedTotal", {
              amount: formatMoney(
                quote.data.services.reduce((sum, line) => sum + line.priceCents, 0),
                currency,
                locale,
              ),
            })}
          </p>
        )}
        {surcharge > 0 && (
          <p className="rounded-lg border border-line bg-surface p-3 text-sm">
            {t("bookingPeak.surcharge", { amount: formatMoney(surcharge, currency, locale) })}
          </p>
        )}
      </div>
      {quote.isError && <ErrorState error={quote.error} onRetry={() => void quote.refetch()} />}
    </>
  );
}
