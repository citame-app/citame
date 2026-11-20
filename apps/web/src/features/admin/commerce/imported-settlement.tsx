import {
  type ImportedSettlement,
  importedPartialPaymentSchema,
  importedSettlementSchema,
  moneyCentsSchema,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { invalidateCommerce } from "./invalidate";
import { inputCents } from "./money";

export function ImportedSettlementForm({
  id,
  version,
  originalTotal,
}: {
  id: string;
  version: number;
  originalTotal?: number;
}) {
  const { t, locale } = useI18n();
  const heading = useId();
  const queries = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [attempted, setAttempted] = useState(false);
  const cents = inputCents(amount);
  const partial = originalTotal !== undefined;
  const validAmount =
    moneyCentsSchema.safeParse(cents).success &&
    (!partial || (cents !== null && cents > 0 && cents < originalTotal));
  const validReference = reference.trim().length >= 3;
  const review = useMutation({
    mutationFn: async (input: ImportedSettlement) => {
      if (partial) await api().commerce.confirmImportedPartialPayment(id, input);
      else await api().commerce.confirmImportedSettlement(id, input);
    },
    onSuccess: async () => {
      toast.success(
        t(partial ? "pos.billingReview.partialSaved" : "pos.billingReview.settlementSaved"),
      );
      await invalidateCommerce(queries);
    },
  });
  const pending = review.isPending || review.isSuccess;
  return (
    <details className="border-t border-line pt-3">
      <summary id={heading} className="cursor-pointer text-sm font-medium">
        {t(partial ? "pos.billingReview.partial" : "pos.billingReview.settle")}
      </summary>
      <form
        aria-labelledby={heading}
        method="post"
        className="mt-3 space-y-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (pending) return;
          const parsed = (
            partial ? importedPartialPaymentSchema : importedSettlementSchema
          ).safeParse({
            appointmentVersion: version,
            amountCents: inputCents(amount),
            reference,
          });
          if (parsed.success && validAmount) {
            review.mutate(parsed.data);
          } else {
            setAttempted(true);
            const name = !validAmount ? "amount" : "reference";
            event.currentTarget.querySelector<HTMLInputElement>(`[name="${name}"]`)?.focus();
          }
        }}
      >
        <p className="text-sm text-muted">
          {partial
            ? t("pos.billingReview.partialHelp", {
                amount: formatMoney(originalTotal, "EUR", locale),
              })
            : t("pos.billingReview.settlementHelp")}
        </p>
        <TextField
          name="amount"
          label={t("pos.billingReview.settlementAmount")}
          value={amount}
          inputMode="decimal"
          required
          disabled={pending}
          error={
            attempted && !validAmount
              ? t(partial ? "pos.billingReview.partialInvalid" : "pos.billingReview.invalidPrice")
              : undefined
          }
          onChange={(event) => setAmount(event.target.value)}
        />
        <TextField
          name="reference"
          label={t("pos.billingReview.reference")}
          hint={t("pos.billingReview.settlementReference")}
          value={reference}
          required
          minLength={3}
          maxLength={300}
          autoCapitalize="none"
          spellCheck={false}
          disabled={pending}
          error={attempted && !validReference ? t("pos.billingReview.invalidReference") : undefined}
          onChange={(event) => setReference(event.target.value)}
        />
        {review.isError && <ErrorState error={review.error} />}
        <Button type="submit" variant="secondary" loading={review.isPending} disabled={pending}>
          {t(partial ? "pos.billingReview.confirmPartial" : "pos.billingReview.confirmSettlement")}
        </Button>
      </form>
    </details>
  );
}
