import type { PublicGiftOffer } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import { buttonClasses } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { formatMoney } from "~/lib/format";

const themes = {
  rose: "border-rose-200 bg-rose-50 text-rose-950",
  sage: "border-emerald-200 bg-emerald-50 text-emerald-950",
  ink: "border-slate-700 bg-slate-900 text-slate-50",
};

export function GiftOfferCard({ offer }: { offer: PublicGiftOffer }) {
  const { t, locale } = useI18n();
  const money = (amount: number) => formatMoney(amount, "EUR", locale);
  return (
    <article
      className={`flex min-h-40 flex-col gap-3 rounded-2xl border p-5 ${themes[offer.theme]}`}
    >
      <h3 className="text-lg font-semibold">{offer.name}</h3>
      {offer.description && <p>{offer.description}</p>}
      <p className="text-sm">
        {t("gift.storefront.value", {
          value: money(offer.amountCents),
          price: money(offer.priceCents),
        })}
      </p>
      {offer.validityDays && (
        <p className="text-sm">{t("gift.storefront.duration", { days: offer.validityDays })}</p>
      )}
      {!!offer.eligibleServices.length && (
        <p className="text-sm">
          {t("gift.restrictedServices", {
            services: offer.eligibleServices.map(({ name }) => name).join(", "),
          })}
        </p>
      )}
    </article>
  );
}

export function GiftStorefront({ offers }: { offers: PublicGiftOffer[] }) {
  const { t } = useI18n();
  if (!offers.length) return null;
  return (
    <section className="editorial-section" aria-labelledby="public-gift-title">
      <div className="wrap editorial-wrap">
        <header className="editorial-section-heading">
          <h2 id="public-gift-title">{t("gift.title")}</h2>
        </header>
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {offers.map((offer) => (
            <li className="flex flex-col gap-3" key={offer.id}>
              <GiftOfferCard offer={offer} />
              <Link
                to="/account/rewards"
                search={{ giftOffer: offer.id }}
                className={buttonClasses({ variant: "secondary" })}
                aria-label={t("gift.storefront.reviewNamed", { name: offer.name })}
              >
                {t("gift.storefront.review")}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
