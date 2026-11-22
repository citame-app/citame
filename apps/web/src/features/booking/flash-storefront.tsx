import type { PublicFlashOffer } from "@sob/contracts";
import { Link } from "@tanstack/react-router";
import { buttonClasses } from "~/components/ui/button";
import { useI18n } from "~/i18n/react";
import { formatMoney } from "~/lib/format";

export function FlashOfferDetails({ offer }: { offer: PublicFlashOffer }) {
  const { t, locale, timeZone } = useI18n();
  const amount = (cents: number) => formatMoney(cents, "EUR", locale);
  const expiry = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(offer.endsAt));
  return (
    <div className="space-y-1 text-sm">
      <p className="font-medium">
        {offer.kind === "percent"
          ? t("flashOffers.discount", {
              amount: new Intl.NumberFormat(locale, {
                style: "percent",
                maximumFractionDigits: 2,
              }).format(offer.value / 10000),
            })
          : t("flashOffers.maximum", {
              amount: amount(Math.min(offer.value, offer.maximumDiscountCents ?? offer.value)),
            })}
      </p>
      <p>{t("flashOffers.ends", { date: expiry })}</p>
      {!!offer.minimumSpendCents && (
        <p>{t("flashOffers.minimum", { amount: amount(offer.minimumSpendCents) })}</p>
      )}
      {offer.kind === "percent" && offer.maximumDiscountCents !== null && (
        <p>{t("flashOffers.maximum", { amount: amount(offer.maximumDiscountCents) })}</p>
      )}
      {offer.perClientLimit !== null && (
        <p>{t("flashOffers.perClient", { count: offer.perClientLimit })}</p>
      )}
    </div>
  );
}

export function FlashStorefront({ offers }: { offers: PublicFlashOffer[] }) {
  const { t } = useI18n();
  if (!offers.length) return null;
  return (
    <section className="editorial-section" aria-labelledby="flash-offer-title">
      <div className="wrap editorial-wrap">
        <header className="editorial-section-heading">
          <h2 id="flash-offer-title">{t("flashOffers.title")}</h2>
        </header>
        <ul className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {offers.map((offer) => (
            <li key={offer.id}>
              <article className="flex h-full min-w-0 flex-col gap-3 rounded-xl border border-line bg-surface p-5">
                <h3 className="break-words text-lg font-semibold">{offer.name}</h3>
                <FlashOfferDetails offer={offer} />
                <p className="text-sm text-muted">
                  {offer.allServices
                    ? t("flashOffers.allServices")
                    : offer.services.map(({ name }) => name).join(", ")}
                </p>
                <Link
                  to="/book"
                  className={`${buttonClasses({ variant: "secondary" })} mt-auto w-fit`}
                  aria-label={t("flashOffers.bookNamed", { name: offer.name })}
                >
                  {t("home.services.book")}
                </Link>
              </article>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
