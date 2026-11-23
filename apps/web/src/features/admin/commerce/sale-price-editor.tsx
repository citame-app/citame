import type { CatalogPriceReview } from "@sob/contracts";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { centsInput, inputCents } from "./money";
import { type ReceiptItem, receiptUnitPrice } from "./pos-cart";

export function SalePriceEditor({
  item,
  open,
  disabled,
  onOpenChange,
  onSave,
}: {
  item: ReceiptItem;
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (base: number, review?: CatalogPriceReview) => void;
}) {
  const { t, locale } = useI18n();
  const id = useId();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [base, setBase] = useState(item.priceCents);
  const reload = useMutation({
    mutationFn: async () => {
      if (item.kind === "custom" || !item.id) throw new Error("Missing catalog item");
      return api().commerce.catalogPrice(item.kind, item.id);
    },
    onSuccess: (current) => setBase(current.unitAmountCents),
  });
  const [invalidReason, setInvalidReason] = useState(false);
  const label = t("pos.changeSalePrice", { name: item.name });
  const catalogPrice = t("pos.catalogPrice", {
    amount: formatMoney(base, "EUR", locale),
  });

  return (
    <div className="mt-2">
      <Button
        variant="secondary"
        type="button"
        className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere]"
        disabled={disabled || reload.isPending}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (!open) {
            setBase(item.priceCents);
            reload.reset();
            setAmount(centsInput(receiptUnitPrice(item)));
            setReason(item.catalogPriceReview?.reason ?? "");
            setInvalidReason(false);
          }
          onOpenChange(!open);
        }}
      >
        {label}
      </Button>
      <div id={id} hidden={!open}>
        {open && (
          <form
            aria-label={label}
            className="mt-3 space-y-3"
            method="post"
            onSubmit={(event) => {
              event.preventDefault();
              const unitAmountCents = inputCents(amount);
              if (unitAmountCents === null || disabled || reload.isPending || reload.isError)
                return;
              const trimmed = reason.trim();
              if (unitAmountCents !== base && trimmed.length < 3) {
                setInvalidReason(true);
                event.currentTarget
                  .querySelector<HTMLInputElement>('input[name="reason"]')
                  ?.focus();
                return;
              }
              onSave(
                base,
                unitAmountCents === base
                  ? undefined
                  : { expectedUnitAmountCents: base, unitAmountCents, reason: trimmed },
              );
            }}
          >
            <TextField
              label={t("pos.salePrice")}
              name="amount"
              hint={catalogPrice}
              value={amount}
              inputMode="decimal"
              pattern={String.raw`\s*[0-9]{1,7}(?:[.,][0-9]{1,2})?\s*`}
              required
              disabled={disabled}
              onChange={(event) => setAmount(event.target.value)}
            />
            <TextField
              label={t("pos.salePriceReason")}
              name="reason"
              value={reason}
              maxLength={200}
              disabled={disabled}
              error={invalidReason ? t("pos.invalidField") : undefined}
              onChange={(event) => {
                setReason(event.target.value);
                if (event.target.value.trim().length >= 3) setInvalidReason(false);
              }}
            />
            <span className="sr-only" role="status">
              {reload.isSuccess ? catalogPrice : ""}
            </span>
            {reload.isError && (
              <p role="alert" className="text-sm text-danger-fg">
                {t("pos.catalogPriceUnavailable")}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={disabled || reload.isPending || reload.isError}>
                {t("pos.applySalePrice")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={disabled}
                loading={reload.isPending}
                onClick={() => reload.mutate()}
              >
                {t("pos.reloadCatalogPrice")}
              </Button>
              {item.catalogPriceReview && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={disabled || reload.isPending || reload.isError}
                  onClick={() => onSave(base)}
                >
                  {t("pos.revertSalePrice")}
                </Button>
              )}
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
