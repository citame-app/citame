import {
  type CalendarAppointment,
  importedPriceReviewSchema,
  type ImportedPriceReview as ReviewInput,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { ErrorState } from "~/components/ui/states";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/i18n/react";
import { api } from "~/lib/api/instance";
import { invalidateCommerce } from "./invalidate";
import { inputCents } from "./money";

export function ImportedPriceReview({
  appointmentId,
  version,
  services,
}: {
  appointmentId: string;
  version: number;
  services: NonNullable<CalendarAppointment["unpricedServices"]>;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const toast = useToast();
  const heading = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [reference, setReference] = useState("");
  const [invalid, setInvalid] = useState(false);
  const review = useMutation({
    mutationFn: (payload: ReviewInput) =>
      api().commerce.reviewImportedPrice(appointmentId, payload),
    onSuccess: async () => {
      toast.success(t("pos.billingReview.saved"));
      await invalidateCommerce(queries);
    },
    onError: async () => {
      await queries.invalidateQueries({ queryKey: ["admin", "calendar"] });
    },
  });
  return (
    <form
      aria-labelledby={heading}
      className="space-y-3 border-t border-line pt-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (review.isPending || review.isSuccess) return;
        const parsed = importedPriceReviewSchema.safeParse({
          appointmentVersion: version,
          reference,
          lines: services.map(({ id }) => ({ id, amountCents: inputCents(values[id] ?? "") })),
        });
        setInvalid(!parsed.success);
        if (parsed.success) review.mutate(parsed.data);
      }}
    >
      <h4 id={heading} className="font-medium">
        {t("pos.billingReview.verifyPrices")}
      </h4>
      <p className="text-sm text-muted">{t("pos.billingReview.priceBasis")}</p>
      {services.map(({ id, name }, index) => (
        <TextField
          key={id}
          label={t("pos.billingReview.price", { name, line: index + 1 })}
          required
          inputMode="decimal"
          value={values[id] ?? ""}
          onChange={(event) => setValues({ ...values, [id]: event.target.value })}
          error={
            invalid && inputCents(values[id] ?? "") === null
              ? t("pos.billingReview.invalidPrice")
              : undefined
          }
          disabled={review.isPending || review.isSuccess}
        />
      ))}
      <TextField
        label={t("pos.billingReview.reference")}
        hint={t("pos.billingReview.referenceHint")}
        required
        minLength={3}
        maxLength={300}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        error={
          invalid && reference.trim().length < 3
            ? t("pos.billingReview.invalidReference")
            : undefined
        }
        disabled={review.isPending || review.isSuccess}
      />
      {review.isError && <ErrorState error={review.error} />}
      <Button
        type="submit"
        variant="secondary"
        loading={review.isPending}
        disabled={review.isSuccess}
      >
        {t("pos.billingReview.savePrices")}
      </Button>
    </form>
  );
}
