import type { Service } from "@sob/contracts";
import type { Locale, Translator } from "~/i18n";
import { formatMoney } from "~/lib/format";

type Priced = Pick<Service, "priceType" | "priceCents" | "currency">;
export function priceLabel(
  t: Translator,
  locale: Locale,
  service: Priced,
  revealHidden = false,
): string {
  if (service.priceType === "variable") return t("services.price.variable");
  if (service.priceType === "hidden" && !revealHidden) return t("services.price.hidden");
  if (service.priceType === "free") return t("services.price.free");
  const amount = formatMoney(service.priceCents, service.currency, locale);
  return service.priceType === "from" ? t("services.price.fromAmount", { amount }) : amount;
}
export function totalPriceLabel(
  t: Translator,
  locale: Locale,
  services: Pick<Service, "priceType">[],
  total: number,
  currency: string,
  revealHidden = false,
) {
  if (services.some((s) => s.priceType === "variable")) return t("services.price.final");
  if (!revealHidden && services.some((s) => s.priceType === "hidden"))
    return t("services.price.hidden");
  const amount = formatMoney(total, currency, locale);
  return services.some((s) => s.priceType === "from")
    ? t("services.price.fromAmount", { amount })
    : amount;
}
