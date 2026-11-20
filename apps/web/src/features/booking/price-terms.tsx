import { needsFinalPrice, type Service } from "@sob/contracts";
import { useState } from "react";
import { useI18n } from "~/i18n/react";
export function usePriceTerms(
  services: Pick<Service, "id" | "priceCents" | "priceType" | "currency" | "quoteHash">[],
) {
  const [accepted, setAccepted] = useState<string | null>(null);
  const required = services.some((s) => needsFinalPrice(s.priceType));
  const signature = JSON.stringify(
    services.map((s) => [
      s.id,
      s.priceType ?? "fixed",
      s.priceCents,
      s.currency,
      s.quoteHash ?? null,
    ]),
  );
  return {
    required,
    accepted: !required || accepted === signature,
    setAccepted: (value: boolean) => setAccepted(value ? signature : null),
  };
}
export function PriceTermsConsent({
  state,
  disabled = false,
}: {
  state: ReturnType<typeof usePriceTerms>;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  if (!state.required) return null;
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-line p-4 text-sm">
      <input
        type="checkbox"
        className="mt-1 size-5 shrink-0 accent-accent"
        checked={state.accepted}
        disabled={disabled}
        onChange={(e) => state.setAccepted(e.target.checked)}
      />
      <span>{t("services.price.accept")}</span>
    </label>
  );
}
