import type { Checkout, HostedPaymentForm, StartPaymentInput, UserRole } from "@sob/contracts";
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
import { centsInput, inputCents } from "./money";
import { printReceipt } from "./print-receipt";

export function CheckoutPanel({
  id,
  mode,
  role,
}: {
  id: string;
  mode: CommerceMode;
  role: UserRole;
}) {
  const { t, locale, timeZone } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const sale = useQuery({
    queryKey: ["commerce", mode, "checkout", id],
    queryFn: () => api().commerce.get(id, mode),
    refetchInterval: (query) =>
      query.state.data?.payments.some((p) => p.status === "pending") ||
      query.state.data?.refunds.some((r) => r.status === "dispatched")
        ? 3000
        : false,
  });
  const capabilities = useQuery({
    queryKey: ["commerce", mode, "capabilities"],
    queryFn: () => api().commerce.capabilities(mode),
  });
  const [amount, setAmount] = useState<string | null>(null);
  const [method, setMethod] = useState<StartPaymentInput["method"]>(
    mode === "client" ? "redsys_card" : "cash",
  );
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<HostedPaymentForm | null>(null);
  const [error, setError] = useState(false);
  const [amountError, setAmountError] = useState(false);
  const pay = useMutation({
    mutationFn: (amountCents: number) =>
      api().commerce.pay(id, { method, amountCents, idempotencyKey: requestKey }, mode),
    onSuccess: (result) => {
      setError(false);
      setForm(result.form);
      if (result.payment.status !== "pending") {
        setAmount(null);
        setRequestKey(crypto.randomUUID());
      }
      void queries.invalidateQueries({ queryKey: ["commerce"] });
    },
    onError: () => setError(true),
  });
  if (sale.isPending) return <Skeleton className="h-72" />;
  if (sale.isError) return <ErrorState error={sale.error} onRetry={() => void sale.refetch()} />;
  const order = sale.data;
  const money = (value: number) => formatMoney(value, order.currency, locale);
  const pending = order.payments.some((p) => p.status === "pending");
  const refundedFor = (id: string) =>
    order.refunds
      .filter((r) => r.paymentId === id && r.status === "succeeded")
      .reduce((sum, r) => sum + r.amountCents, 0);
  const refundableFor = (id: string, amount: number) =>
    Math.max(
      0,
      amount -
        order.refunds
          .filter((r) => r.paymentId === id && r.status !== "failed")
          .reduce((sum, r) => sum + r.amountCents, 0),
    );
  const review = order.payments.some(
    (p) => p.status === "reconciliation" && refundedFor(p.id) < p.amountCents,
  );
  const options = [
    ...(mode === "admin"
      ? [
          { value: "cash", label: t("commerce.cash") },
          { value: "external_card", label: t("commerce.external_card") },
        ]
      : []),
    ...(capabilities.data?.card
      ? [{ value: "redsys_card", label: t("commerce.redsys_card") }]
      : []),
    ...(capabilities.data?.bizum
      ? [{ value: "redsys_bizum", label: t("commerce.redsys_bizum") }]
      : []),
  ];
  return (
    <section
      aria-label={t("commerce.receipt")}
      className="space-y-6 rounded-xl border border-line bg-surface p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-heading">{t("commerce.receipt")}</h2>
          <p className="break-all text-xs text-muted">{order.id}</p>
        </div>
        <p
          role="status"
          className="rounded-full bg-accent-soft px-3 py-1 text-sm font-semibold text-accent-soft-fg"
        >
          {t(`commerce.status.${order.status}`)}
        </p>
      </div>
      <ul className="divide-y divide-line">
        {order.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-3 py-3">
            <span>
              {line.description}
              <span className="ml-2 text-muted">× {line.quantity}</span>
            </span>
            <span className="whitespace-nowrap font-medium">
              {money(line.quantity * line.unitAmountCents)}
            </span>
          </li>
        ))}
      </ul>
      <dl className="space-y-2 border-t border-line pt-4">
        {[
          ["commerce.discount", -order.discountCents],
          ["commerce.tip", order.tipCents],
          ["commerce.tax", order.taxCents],
          ["commerce.total", order.totalCents],
          ["commerce.paid", order.paidCents],
          ["commerce.refunded", order.refundedCents],
          ["commerce.balance", order.balanceCents],
        ].map(([key, value]) => (
          <div key={key} className="flex justify-between gap-4">
            <dt className="text-muted">{t(key as "commerce.total")}</dt>
            <dd className="font-semibold tabular-nums">{money(Number(value))}</dd>
          </div>
        ))}
      </dl>
      {capabilities.data?.environment === "test" && (
        <p className="rounded-md bg-warning-soft p-3 text-sm text-warning-fg">
          {t("commerce.testMode")}
        </p>
      )}
      {order.overpaidCents > 0 && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.overpaid")}: {money(order.overpaidCents)}
        </p>
      )}
      {review && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.review")}
        </p>
      )}
      {pending && order.balanceCents > 0 && <p role="status">{t("commerce.pending")}</p>}
      {!pending && order.balanceCents > 0 && order.payments.some((p) => p.status === "failed") && (
        <p role="status">{t("commerce.declined")}</p>
      )}
      {form && order.status === "open" && !review ? (
        <form method="post" action={form.action} className="space-y-3">
          {Object.entries(form.fields).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <p className="text-sm text-muted">{t("commerce.bankHelp")}</p>
          <Button type="submit" disabled={!online}>
            {t("commerce.bankSubmit")}
          </Button>
        </form>
      ) : null}
      {order.status === "open" && !pending && !review && !form && (
        <div>
          {capabilities.isPending ? (
            <Skeleton className="h-20" />
          ) : options.length ? (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const cents = inputCents(amount ?? centsInput(order.balanceCents));
                if (cents === null || cents <= 0 || cents > order.balanceCents) {
                  setAmountError(true);
                  return;
                }
                setAmountError(false);
                pay.mutate(cents);
              }}
            >
              <TextField
                label={t("commerce.amount")}
                inputMode="decimal"
                value={amount ?? centsInput(order.balanceCents)}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setAmountError(false);
                  setError(false);
                  setRequestKey(crypto.randomUUID());
                }}
                error={amountError ? t("commerce.amountError") : undefined}
              />
              <SelectField
                label={t("commerce.method")}
                value={method}
                options={options}
                onChange={(value) => {
                  setMethod(value as StartPaymentInput["method"]);
                  setRequestKey(crypto.randomUUID());
                  setError(false);
                }}
              />
              {error && (
                <p role="alert" className="text-danger-fg sm:col-span-2">
                  {t("commerce.paymentError")}
                </p>
              )}
              <Button type="submit" disabled={pay.isPending || !online}>
                {t(method.startsWith("redsys_") ? "commerce.continue" : "commerce.record")}
              </Button>
            </form>
          ) : (
            <p>{t("commerce.unavailable")}</p>
          )}
        </div>
      )}
      {order.payments.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold">{t("commerce.history")}</h3>
          {order.payments.map((payment) => (
            <div key={payment.id} className="rounded-lg border border-line p-3">
              <p>
                {t(`commerce.${payment.method}`)} · {money(payment.amountCents)}
              </p>
              <p className="text-sm text-muted">
                {refundedFor(payment.id) >= payment.amountCents
                  ? t("commerce.status.refunded")
                  : payment.status === "reconciliation"
                    ? t("commerce.review")
                    : payment.status === "succeeded"
                      ? t("commerce.status.paid")
                      : payment.status === "failed"
                        ? t("commerce.declined")
                        : t("commerce.pending")}
              </p>
              {mode === "admin" &&
                role === "owner" &&
                ["succeeded", "reconciliation"].includes(payment.status) &&
                refundableFor(payment.id, payment.amountCents) > 0 && (
                  <RefundForm
                    paymentId={payment.id}
                    amountCents={refundableFor(payment.id, payment.amountCents)}
                  />
                )}
              {mode === "admin" &&
                role === "owner" &&
                payment.status === "pending" &&
                Date.now() - Date.parse(payment.updatedAt ?? payment.createdAt) >= 60000 && (
                  <PaymentReconciliation paymentId={payment.id} />
                )}
            </div>
          ))}
        </div>
      )}
      {order.refunds.length > 0 && (
        <div className="space-y-3">
          {order.refunds.map((refund) => (
            <RefundStatus
              key={refund.id}
              refund={refund}
              owner={mode === "admin" && role === "owner"}
            />
          ))}
        </div>
      )}
      <Button variant="secondary" onClick={() => printReceipt(order, locale, t, timeZone)}>
        {t("commerce.print")}
      </Button>
    </section>
  );
}
function RefundForm({ paymentId, amountCents }: { paymentId: string; amountCents: number }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const request = useMutation({
    mutationFn: async () => {
      const cents = inputCents(amount);
      if (cents === null || cents <= 0 || cents > amountCents || reason.trim().length < 3)
        throw new Error("Invalid refund");
      return api().commerce.refund(paymentId, {
        amountCents: cents,
        reason: reason.trim(),
        idempotencyKey: key,
      });
    },
    onSuccess: () => {
      setOpen(false);
      void queries.invalidateQueries({ queryKey: ["commerce"] });
    },
  });
  return (
    <div className="mt-3 space-y-3">
      {!open ? (
        <Button
          variant="ghost"
          onClick={() => {
            request.reset();
            setKey(crypto.randomUUID());
            setOpen(true);
          }}
        >
          {t("commerce.refund")}
        </Button>
      ) : (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            request.mutate();
          }}
        >
          <TextField
            label={t("commerce.refundAmount")}
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              request.reset();
              setKey(crypto.randomUUID());
            }}
          />
          <TextField
            label={t("commerce.refundReason")}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              request.reset();
              setKey(crypto.randomUUID());
            }}
          />
          {request.isError && <p role="alert">{t("commerce.paymentError")}</p>}
          <Button type="submit" disabled={request.isPending}>
            {t("commerce.requestRefund")}
          </Button>
        </form>
      )}
    </div>
  );
}
function RefundStatus({ refund, owner }: { refund: Checkout["refunds"][number]; owner: boolean }) {
  const { t, locale } = useI18n();
  const queries = useQueryClient();
  const [reference, setReference] = useState("");
  const [outcome, setOutcome] = useState("");
  const changed = () => void queries.invalidateQueries({ queryKey: ["commerce"] });
  const execute = useMutation({
    mutationFn: () => api().commerce.executeRefund(refund.id),
    onSuccess: changed,
  });
  const reconcile = useMutation({
    mutationFn: () =>
      api().commerce.reconcileRefund(refund.id, {
        outcome: outcome as "succeeded" | "failed",
        reference: reference.trim(),
      }),
    onSuccess: changed,
  });
  const current = reconcile.data ?? execute.data ?? refund;
  const canReconcile =
    current.status === "reconciliation" ||
    (current.status === "dispatched" &&
      Date.now() - Date.parse(refund.updatedAt ?? refund.createdAt) >= 60000);
  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <p className="font-semibold">
        {t("commerce.refunded")} · {formatMoney(current.amountCents, "EUR", locale)}
      </p>
      <p role="status">
        {t(
          current.status === "succeeded"
            ? "commerce.refundDone"
            : current.status === "requested"
              ? "commerce.refundRequested"
              : current.status === "failed"
                ? "commerce.refundFailed"
                : "commerce.refundReview",
        )}
      </p>
      {owner && current.status === "requested" && (
        <Button disabled={execute.isPending} onClick={() => execute.mutate()}>
          {t("commerce.sendRefund")}
        </Button>
      )}
      {owner && canReconcile && (
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (reference.trim().length >= 8 && outcome) reconcile.mutate();
          }}
        >
          <TextField
            label={t("commerce.bankReference")}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            minLength={8}
            required
          />
          <SelectField
            label={t("commerce.reconcile")}
            value={outcome}
            options={[
              { value: "", label: "—" },
              { value: "succeeded", label: t("commerce.refundSucceeded") },
              { value: "failed", label: t("commerce.refundNotSent") },
            ]}
            onChange={setOutcome}
          />
          <Button
            type="submit"
            disabled={!outcome || reference.trim().length < 8 || reconcile.isPending}
          >
            {t("commerce.reconcile")}
          </Button>
        </form>
      )}
      {(execute.isError || reconcile.isError) && (
        <p role="alert" className="text-danger-fg">
          {t("commerce.paymentError")}
        </p>
      )}
    </div>
  );
}

function PaymentReconciliation({ paymentId }: { paymentId: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [reference, setReference] = useState("");
  const [outcome, setOutcome] = useState("");
  const reconcile = useMutation({
    mutationFn: () =>
      api().commerce.reconcilePayment(paymentId, {
        outcome: outcome as "succeeded" | "failed",
        reference: reference.trim(),
      }),
    onSuccess: () => void queries.invalidateQueries({ queryKey: ["commerce"] }),
  });
  return (
    <form
      aria-label={t("commerce.reconcilePayment")}
      className="mt-3 grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (reference.trim().length >= 8 && outcome) reconcile.mutate();
      }}
    >
      <p className="text-sm text-muted sm:col-span-2">{t("commerce.paymentReconcileHelp")}</p>
      <TextField
        label={t("commerce.bankReference")}
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        minLength={8}
        required
      />
      <SelectField
        label={t("commerce.reconcilePayment")}
        value={outcome}
        options={[
          { value: "", label: "—" },
          { value: "succeeded", label: t("commerce.bankPaid") },
          { value: "failed", label: t("commerce.bankNotCharged") },
        ]}
        onChange={setOutcome}
      />
      {reconcile.isError && <p role="alert">{t("commerce.paymentError")}</p>}
      <Button
        type="submit"
        disabled={!outcome || reference.trim().length < 8 || reconcile.isPending}
      >
        {t("commerce.reconcilePayment")}
      </Button>
    </form>
  );
}
