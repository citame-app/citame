import type { Checkout, CheckoutPrices } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError, NetworkError, ResponseShapeError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { centsInput, inputCents } from "./money";

export function CheckoutPricesForm({
  order,
  onSaved,
  onReload,
  disabled = false,
}: {
  order: Checkout;
  onSaved: () => void;
  onReload: () => void;
  disabled?: boolean;
}) {
  const { t, locale } = useI18n();
  const lines = order.lines.filter((l) => l.pricePending);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      lines.map((l) => [
        l.id,
        l.minimumUnitAmountCents ? centsInput(l.minimumUnitAmountCents) : "",
      ]),
    ),
  );
  const [invalid, setInvalid] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const packet = useRef<CheckoutPrices | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      packet.current ??= {
        version: order.pricingVersion ?? 1,
        lines: lines.map((l) => {
          const cents = inputCents(values[l.id] ?? "");
          if (cents === null) throw new Error("Enter a final amount");
          return { id: l.id, unitAmountCents: cents };
        }),
      };
      return api().commerce.finalizePrices(order.id, packet.current);
    },
    onSuccess: onSaved,
    onError: (error) => {
      const unknown =
        uncertain ||
        error instanceof NetworkError ||
        error instanceof ResponseShapeError ||
        (error instanceof ApiError && error.status >= 500);
      setUncertain(unknown);
      if (!unknown) packet.current = null;
    },
  });
  const submit = () => {
    const valid = lines.every((l) => {
      const cents = inputCents(values[l.id] ?? "");
      return cents !== null && cents >= (l.minimumUnitAmountCents ?? 0);
    });
    setInvalid(!valid);
    if (valid || uncertain) save.mutate();
  };
  return (
    <section
      aria-label={t("services.price.finalize")}
      className="space-y-4 border-y border-line py-5"
    >
      <h3 className="font-semibold">{t("services.price.finalize")}</h3>
      <p className="text-sm text-muted">{t("services.price.pending")}</p>
      {lines.map((line) => (
        <TextField
          key={line.id}
          label={line.description}
          inputMode="decimal"
          value={values[line.id] ?? ""}
          disabled={disabled || save.isPending || uncertain}
          hint={
            line.minimumUnitAmountCents
              ? t("services.price.minimum", {
                  amount: formatMoney(line.minimumUnitAmountCents, order.currency, locale),
                })
              : undefined
          }
          error={
            invalid &&
            (inputCents(values[line.id] ?? "") === null ||
              (inputCents(values[line.id] ?? "") ?? -1) < (line.minimumUnitAmountCents ?? 0))
              ? t("services.error.invalid")
              : undefined
          }
          onChange={(e) => setValues((previous) => ({ ...previous, [line.id]: e.target.value }))}
        />
      ))}
      {save.isError && <ErrorState error={save.error} />}
      <div className="flex flex-wrap gap-3">
        <Button loading={save.isPending} disabled={disabled} onClick={submit}>
          {t("services.price.finalize")}
        </Button>
        {save.isError && (
          <Button variant="secondary" disabled={save.isPending} onClick={onReload}>
            {t("services.price.reload")}
          </Button>
        )}
      </div>
    </section>
  );
}
