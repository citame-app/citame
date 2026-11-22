import { type GiftOfferOrder, giftOfferOrderSchema } from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { GiftOfferCard } from "~/features/booking/gift-storefront";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { invalidateCommerce } from "./invalidate";

export function GiftOfferOrderForm({
  offerId,
  actorId,
  onOrder,
}: {
  offerId: string;
  actorId: string;
  onOrder: (cardId: string) => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const heading = useId();
  const storageKey = `citame:gift-order:${actorId}:${offerId}`;
  const [restored, setRestored] = useState(false);
  const [pending, setPending] = useState<GiftOfferOrder | null>(null);
  useEffect(() => {
    try {
      const saved = giftOfferOrderSchema.safeParse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? "null"),
      );
      setPending(saved.success && saved.data.offerId === offerId ? saved.data : null);
    } catch {
      setPending(null);
    } finally {
      setRestored(true);
    }
  }, [offerId, storageKey]);
  const catalog = useQuery({
    queryKey: ["gift-cards", "public-offers"],
    queryFn: () => api().giftCards.publicOffers(),
    refetchOnMount: "always",
  });
  const offer = catalog.data?.offers.find(({ id }) => id === offerId);
  const clear = () => {
    setPending(null);
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* Storage can be disabled. */
    }
  };
  const pay = useMutation({
    mutationFn: (request: GiftOfferOrder) => api().giftCards.orderOffer(request),
    onSuccess: (purchase) => {
      clear();
      void invalidateCommerce(queries);
      onOrder(purchase.card.id);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        clear();
        void catalog.refetch();
      }
    },
  });
  return (
    <form
      aria-labelledby={heading}
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!restored || !online || pay.isPending || (!pending && !offer)) return;
        const request = pending ?? {
          offerId,
          version: offer?.version ?? 0,
          idempotencyKey: crypto.randomUUID(),
        };
        setPending(request);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(request));
        } catch {
          /* Keep the retry in memory. */
        }
        pay.mutate(request);
      }}
    >
      <h3 id={heading} className="font-semibold">
        {t("gift.storefront.review")}
      </h3>
      {offer && (!pending || pending.version === offer.version) && <GiftOfferCard offer={offer} />}
      {!pending && catalog.isPending && <Skeleton className="h-24" />}
      {!pending && catalog.isError && (
        <ErrorState error={catalog.error} onRetry={() => void catalog.refetch()} />
      )}
      {!pending && catalog.isSuccess && !offer && (
        <p className="text-muted">{t("gift.storefront.unavailable")}</p>
      )}
      {pay.isError && (
        <p role="alert" className="text-danger-fg">
          {t(pending ? "gift.purchaseUncertain" : "gift.storefront.orderError")}
        </p>
      )}
      {(offer || pending) && (
        <Button type="submit" disabled={!restored || !online || pay.isPending}>
          {t(pending ? "gift.retryPurchase" : "gift.storefront.createOrder")}
        </Button>
      )}
    </form>
  );
}
