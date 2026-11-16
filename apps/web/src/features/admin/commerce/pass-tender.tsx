import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { formatMoney } from "~/lib/format";
import { invalidateCommerce } from "./invalidate";
import { centsInput } from "./money";
export function PassTender({ checkoutId, mode }: { checkoutId: string; mode: CommerceMode }) {
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [selected, setSelected] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const eligible = useQuery({
    queryKey: ["passes", mode, "eligible", checkoutId],
    queryFn: () => api().passes.eligible(checkoutId, mode),
    refetchOnMount: "always",
    refetchInterval: 30000,
  });
  const options =
    eligible.data?.eligible.flatMap((p) =>
      p.lines.map((line) => ({
        value: `${p.period.id}:${line.id}`,
        label: `${p.name} · ${line.description} · ${formatMoney(line.amountCents, "EUR", locale)}`,
        pass: p,
        line,
      })),
    ) ?? [];
  const choice = options.find((o) => o.value === selected) ?? options[0];
  const pay = useMutation({
    mutationFn: () => {
      if (!choice) throw new Error("No visit selected");
      return api().commerce.pay(
        checkoutId,
        {
          method: choice.pass.kind,
          passPeriodId: choice.pass.period.id,
          checkoutLineId: choice.line.id,
          amountCents: choice.line.amountCents,
          idempotencyKey: key,
        },
        mode,
      );
    },
    onSuccess: () => {
      setKey(crypto.randomUUID());
      void invalidateCommerce(queries);
    },
  });
  if (eligible.isPending) return <Skeleton className="h-16" />;
  if (eligible.isError)
    return <ErrorState error={eligible.error} onRetry={() => void eligible.refetch()} />;
  if (!options.length) return null;
  return (
    <form
      className="space-y-3 rounded-xl border border-line bg-surface p-4"
      onSubmit={(e) => {
        e.preventDefault();
        pay.mutate();
      }}
    >
      <h3 className="font-semibold">{t("passes.redeem")}</h3>
      <p className="text-sm text-muted">{t("passes.tenderHelp")}</p>
      <SelectField
        label={t("passes.line")}
        value={choice?.value ?? ""}
        options={options}
        onChange={(v) => {
          setSelected(v);
          setKey(crypto.randomUUID());
          pay.reset();
        }}
      />
      {pay.isError && <p role="alert">{t("passes.error")}</p>}
      <Button type="submit" disabled={!online || pay.isPending || !choice}>
        {t("passes.redeem")}
      </Button>
    </form>
  );
}
export function PassPurchaseRefund({
  periodId,
  paymentId,
  maximumCents,
}: {
  periodId: string;
  paymentId: string;
  maximumCents: number;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      {!open ? (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {t("commerce.refund")}
        </Button>
      ) : (
        <QuotedRefund
          periodId={periodId}
          paymentId={paymentId}
          maximumCents={maximumCents}
          onSaved={() => setOpen(false)}
        />
      )}
    </div>
  );
}
function QuotedRefund({
  periodId,
  paymentId,
  maximumCents,
  onSaved,
}: {
  periodId: string;
  paymentId: string;
  maximumCents: number;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const [units, setUnits] = useState("0");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const valid = /^\d{1,4}$/.test(units) && Number(units) <= 1000;
  const quote = useQuery({
    queryKey: ["passes", "refund-quote", periodId, paymentId, units],
    queryFn: () => api().passes.refundQuote(periodId, paymentId, Number(units)),
    enabled: valid,
    retry: false,
    staleTime: 0,
  });
  const refund = useMutation({
    mutationFn: () => {
      if (
        !quote.data ||
        !valid ||
        quote.data.amountCents <= 0 ||
        quote.data.amountCents > maximumCents ||
        reason.trim().length < 3
      )
        throw new Error("Invalid refund quote");
      return api().commerce.refund(paymentId, {
        amountCents: quote.data.amountCents,
        reason: reason.trim(),
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      void invalidateCommerce(queries);
      onSaved();
    },
    onError: () => void quote.refetch(),
  });
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        refund.mutate();
      }}
    >
      <p className="text-sm text-muted sm:col-span-2">{t("passes.refundHelp")}</p>
      {quote.data?.accessFee && (
        <p className="text-sm text-muted sm:col-span-2">{t("passes.feeHelp")}</p>
      )}
      <TextField
        label={t("passes.refundUnits")}
        type="number"
        min={0}
        max={1000}
        value={units}
        onChange={(e) => {
          setUnits(e.target.value);
          setKey(crypto.randomUUID());
          refund.reset();
        }}
      />
      <TextField
        label={t("commerce.refundAmount")}
        value={quote.data ? centsInput(quote.data.amountCents) : ""}
        readOnly
      />
      <TextField
        label={t("commerce.refundReason")}
        value={reason}
        maxLength={300}
        onChange={(e) => {
          setReason(e.target.value);
          setKey(crypto.randomUUID());
          refund.reset();
        }}
      />
      {(quote.isError || refund.isError) && <p role="alert">{t("passes.error")}</p>}
      <Button
        type="submit"
        disabled={
          !online ||
          refund.isPending ||
          quote.isFetching ||
          !valid ||
          !quote.data?.amountCents ||
          reason.trim().length < 3
        }
      >
        {t("commerce.requestRefund")}
      </Button>
    </form>
  );
}
