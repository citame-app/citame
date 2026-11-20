import {
  type Checkout,
  giftCardCodeSchema,
  type HostedPaymentForm,
  type StartPaymentInput,
  type UserRole,
} from "@sob/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { SelectField } from "~/components/ui/select-field";
import { ErrorState, Skeleton, useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import type { CommerceMode } from "~/lib/api/commerce-endpoints";
import { api } from "~/lib/api/instance";
import { dateFormatter, formatMoney } from "~/lib/format";
import { CheckoutPricesForm } from "./checkout-prices";
import { invalidateCommerce } from "./invalidate";
import { centsInput, inputCents } from "./money";
import { PassPurchaseRefund, PassTender } from "./pass-tender";
import { printReceipt } from "./print-receipt";
import { RewardReceipt, RewardTender } from "./reward-tender";
import { StockReturn } from "./stock-return";

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
  const [selectedMethod, setMethod] = useState<StartPaymentInput["method"]>(
    mode === "client" ? "redsys_card" : "cash",
  );
  const [giftCode, setGiftCode] = useState("");
  const [giftCodeError, setGiftCodeError] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<HostedPaymentForm | null>(null);
  const [error, setError] = useState(false);
  const [amountError, setAmountError] = useState(false);
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
    ...(capabilities.data?.giftCards &&
    !sale.data?.externalBalance &&
    !sale.data?.lines.some((line) => line.kind === "gift_card")
      ? [{ value: "gift_card", label: t("commerce.gift_card") }]
      : []),
  ];
  const method = (
    options.some((option) => option.value === selectedMethod)
      ? selectedMethod
      : (options[0]?.value ?? selectedMethod)
  ) as StartPaymentInput["method"];
  const pay = useMutation({
    mutationFn: (amountCents: number) =>
      api().commerce.pay(
        id,
        {
          method,
          amountCents,
          idempotencyKey: requestKey,
          ...(method === "gift_card" ? { giftCardCode: giftCardCodeSchema.parse(giftCode) } : {}),
        },
        mode,
      ),
    onSuccess: (result) => {
      setError(false);
      setForm(result.form);
      if (result.payment.status !== "pending") {
        setAmount(null);
        setGiftCode("");
        setRequestKey(crypto.randomUUID());
      }
      void invalidateCommerce(queries);
    },
    onError: () => setError(true),
  });
  const voidSale = useMutation({
    mutationFn: () => api().commerce.void(id, mode),
    onSuccess: () => {
      setForm(null);
      void invalidateCommerce(queries);
    },
  });
  if (sale.isPending) return <Skeleton className="h-72" />;
  if (sale.isError) return <ErrorState error={sale.error} onRetry={() => void sale.refetch()} />;
  const order = sale.data;
  const unresolved = order.lines.some((line) => line.pricePending);
  const payableCents =
    unresolved && order.protection?.state !== "pending"
      ? 0
      : (order.payableCents ?? order.balanceCents);
  const money = (value: number) => formatMoney(value, order.currency, locale);
  const canRefund = capabilities.data?.permissions?.refunds ?? role === "owner";
  const clientPurchase =
    mode === "client" &&
    order.lines.some((line) =>
      ["gift_card", "package_purchase", "membership_period"].includes(line.kind),
    );
  const canReturn = capabilities.data?.permissions?.writeInventory ?? role === "owner";
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
      {(mode === "admin" || clientPurchase) &&
        order.status === "open" &&
        !order.protection &&
        !order.payments.some((p) => p.status !== "failed") && (
          <details>
            <summary className="cursor-pointer py-2 font-medium">
              {t(clientPurchase ? "passes.cancelPurchase" : "inventory.void")}
            </summary>
            <p className="my-2 text-sm text-muted">
              {t(clientPurchase ? "passes.cancelPurchaseHelp" : "inventory.voidHelp")}
            </p>
            <Button
              variant="secondary"
              disabled={!online || voidSale.isPending}
              onClick={() => voidSale.mutate()}
            >
              {t(clientPurchase ? "passes.cancelPurchase" : "inventory.void")}
            </Button>
            {voidSale.isError && <p role="alert">{t("inventory.error")}</p>}
          </details>
        )}
      {mode === "admin" &&
        canReturn &&
        order.fulfilledAt &&
        order.lines.some((line) => line.kind === "product") && <StockReturn checkout={order} />}
      <ul className="divide-y divide-line">
        {order.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-3 py-3">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">
              {line.description}
              <span className="ml-2 text-muted">× {line.quantity}</span>
            </span>
            <span className="shrink-0 whitespace-nowrap font-medium">
              {line.pricePending
                ? t("services.price.variable")
                : money(line.quantity * line.unitAmountCents)}
            </span>
          </li>
        ))}
      </ul>
      <dl className="space-y-2 border-t border-line pt-4">
        {order.externalBalance && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted">{t("pos.billingReview.previousPayment")}</dt>
            <dd className="font-semibold tabular-nums">
              {money(order.externalBalance.paidInBooksyCents)}
            </dd>
          </div>
        )}
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
      {unresolved &&
        (mode === "admin" ? (
          <CheckoutPricesForm
            key={`${order.id}:${order.pricingVersion ?? 1}`}
            order={order}
            disabled={!online || pending || review}
            onSaved={() => {
              void invalidateCommerce(queries);
            }}
            onReload={() => {
              void sale.refetch();
            }}
          />
        ) : (
          <p role="status">{t("services.price.pending")}</p>
        ))}
      <RewardReceipt checkout={order} mode={mode} canRefund={canRefund} />
      {order.status === "open" &&
        order.clientId &&
        !order.reward &&
        !unresolved &&
        !order.payments.length &&
        order.lines.some((line) => ["service", "product", "custom"].includes(line.kind)) && (
          <details className="space-y-3">
            <summary className="cursor-pointer py-2 font-medium">{t("loyalty.title")}</summary>
            <RewardTender checkout={order} mode={mode} />
          </details>
        )}
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
      {payableCents === 0 && order.status === "open" && order.balanceCents > 0 && (
        <p role="status">{t("protection.notDue")}</p>
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
      {order.status === "open" &&
        payableCents > 0 &&
        !pending &&
        !review &&
        !form &&
        !order.reward &&
        order.appointmentId &&
        !order.externalBalance &&
        order.clientId &&
        !unresolved && <PassTender checkoutId={order.id} mode={mode} />}
      {order.status === "open" && payableCents > 0 && !pending && !review && !form && (
        <div>
          {capabilities.isPending ? (
            <Skeleton className="h-20" />
          ) : options.length ? (
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const cents = inputCents(amount ?? centsInput(payableCents));
                if (cents === null || cents <= 0 || cents > payableCents) {
                  setAmountError(true);
                  return;
                }
                setAmountError(false);
                if (method === "gift_card" && !giftCardCodeSchema.safeParse(giftCode).success) {
                  setGiftCodeError(true);
                  return;
                }
                setGiftCodeError(false);
                pay.mutate(cents);
              }}
            >
              <TextField
                label={t("commerce.amount")}
                inputMode="decimal"
                value={amount ?? centsInput(payableCents)}
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
              {method === "gift_card" && (
                <TextField
                  label={t("gift.code")}
                  value={giftCode}
                  autoComplete="off"
                  maxLength={80}
                  onChange={(event) => {
                    setGiftCode(event.target.value);
                    setGiftCodeError(false);
                    setError(false);
                    setRequestKey(crypto.randomUUID());
                  }}
                  error={giftCodeError ? t("gift.invalidCode") : undefined}
                />
              )}
              {error && (
                <p role="alert" className="text-danger-fg sm:col-span-2">
                  {t(method === "gift_card" ? "gift.paymentError" : "commerce.paymentError")}
                </p>
              )}
              <Button type="submit" disabled={pay.isPending || !online}>
                {t(
                  method === "gift_card"
                    ? "gift.redeem"
                    : method.startsWith("redsys_")
                      ? "commerce.continue"
                      : "commerce.record",
                )}
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
                {payment.merchantInitiated
                  ? t("passes.automaticCharge")
                  : t(`commerce.${payment.method}`)}{" "}
                · {money(payment.amountCents)}
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
                canRefund &&
                ["succeeded", "reconciliation"].includes(payment.status) &&
                refundableFor(payment.id, payment.amountCents) > 0 &&
                (order.lines[0]?.passPeriodId ? (
                  <PassPurchaseRefund
                    periodId={order.lines[0].passPeriodId}
                    paymentId={payment.id}
                    maximumCents={refundableFor(payment.id, payment.amountCents)}
                  />
                ) : (
                  <RefundForm
                    paymentId={payment.id}
                    amountCents={refundableFor(payment.id, payment.amountCents)}
                    wholeVisit={payment.method === "package" || payment.method === "membership"}
                  />
                ))}
              {mode === "admin" &&
                canRefund &&
                payment.order &&
                payment.reconcileAfter &&
                Date.now() >= Date.parse(payment.reconcileAfter) && (
                  <PaymentReconciliation paymentId={payment.id} bankOrder={payment.order} />
                )}
            </div>
          ))}
        </div>
      )}
      {order.refunds.length > 0 && (
        <div className="space-y-3">
          {order.refunds.map((refund) => (
            <RefundStatus key={refund.id} refund={refund} owner={mode === "admin" && canRefund} />
          ))}
        </div>
      )}
      <Button variant="secondary" onClick={() => printReceipt(order, locale, t, timeZone)}>
        {t("commerce.print")}
      </Button>
    </section>
  );
}
function RefundForm({
  paymentId,
  amountCents,
  wholeVisit = false,
}: {
  paymentId: string;
  amountCents: number;
  wholeVisit?: boolean;
}) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const request = useMutation({
    mutationFn: async () => {
      const cents = wholeVisit ? amountCents : inputCents(amount);
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
      void invalidateCommerce(queries);
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
            value={wholeVisit ? centsInput(amountCents) : amount}
            readOnly={wholeVisit}
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
  const { t, locale, timeZone } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [confirmCancellation, setConfirmCancellation] = useState(false);
  const [reference, setReference] = useState("");
  const [outcome, setOutcome] = useState("");
  const changed = () => void invalidateCommerce(queries);
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
  const cancellation = useMutation({
    networkMode: "always",
    mutationFn: () => api().commerce.cancelRefund(refund.id),
    onSuccess: () => setConfirmCancellation(false),
    onSettled: () => invalidateCommerce(queries),
  });
  const current = cancellation.data ?? reconcile.data ?? execute.data ?? refund;
  const canManageReservation = owner && current.status === "requested";
  const canReconcile =
    current.status === "reconciliation" ||
    (current.status === "dispatched" &&
      Date.now() - Date.parse(refund.updatedAt ?? refund.createdAt) >= 60000);
  return (
    <div className="space-y-3 rounded-lg border border-line p-4">
      <p className="font-semibold">
        {t(current.status === "succeeded" ? "commerce.refunded" : "commerce.refund")} ·{" "}
        {formatMoney(current.amountCents, "EUR", locale)}
      </p>
      {(current.status === "requested" || current.cancelledAt) && (
        <p className="text-sm text-muted">
          #{current.id.slice(-8)} · {current.reason}
        </p>
      )}
      <p role="status">
        {t(
          current.cancelledAt
            ? "commerce.refundCancelled"
            : current.status === "succeeded"
              ? "commerce.refundDone"
              : current.status === "requested"
                ? "commerce.refundRequested"
                : current.status === "failed"
                  ? "commerce.refundFailed"
                  : "commerce.refundReview",
        )}
      </p>
      {current.cancelledAt && (
        <time dateTime={current.cancelledAt} className="block text-sm text-muted">
          {dateFormatter(locale, { dateStyle: "medium", timeStyle: "short", timeZone }).format(
            new Date(current.cancelledAt),
          )}
        </time>
      )}
      {canManageReservation && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!online || execute.isPending || cancellation.isPending || confirmCancellation}
            onClick={() => execute.mutate()}
          >
            {t("commerce.sendRefund")}
          </Button>
          <Button
            variant="secondary"
            disabled={!online || execute.isPending || cancellation.isPending}
            onClick={() => {
              cancellation.reset();
              setConfirmCancellation(true);
            }}
          >
            {t("commerce.cancelRefund")}
          </Button>
        </div>
      )}
      {canManageReservation && confirmCancellation && (
        <ConfirmDialog
          open={confirmCancellation}
          onOpenChange={setConfirmCancellation}
          onConfirm={() => {
            if (online && !execute.isPending && !cancellation.isPending) cancellation.mutate();
          }}
          title={t("commerce.cancelRefund")}
          description={t("commerce.cancelRefundHelp", {
            amount: formatMoney(current.amountCents, "EUR", locale),
          })}
          cancelLabel={t("admin.cancel")}
          confirmLabel={t("commerce.cancelRefundConfirm")}
          destructive
          pending={cancellation.isPending}
        >
          <p className="mt-2 break-all text-sm">
            {current.id} · {current.reason}
          </p>
          {cancellation.isError && <p role="alert">{t("commerce.paymentError")}</p>}
        </ConfirmDialog>
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

function PaymentReconciliation({ paymentId, bankOrder }: { paymentId: string; bankOrder: string }) {
  const { t } = useI18n();
  const queries = useQueryClient();
  const online = useOnline();
  const [reference, setReference] = useState("");
  const [outcome, setOutcome] = useState("");
  const reconcile = useMutation({
    networkMode: "always",
    mutationFn: () =>
      api().commerce.reconcilePayment(paymentId, {
        outcome: outcome as "succeeded" | "failed",
        reference: reference.trim(),
      }),
    onSuccess: () => void invalidateCommerce(queries),
  });
  return (
    <form
      aria-label={t("commerce.reconcilePayment")}
      method="post"
      className="mt-3 grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (online && !reconcile.isPending && reference.trim().length >= 8 && outcome)
          reconcile.mutate();
      }}
    >
      <p className="text-sm sm:col-span-2">
        {t("commerce.bankOrder")} · {bankOrder}
      </p>
      <p className="text-sm text-muted sm:col-span-2">{t("commerce.paymentReconcileHelp")}</p>
      <TextField
        label={t("commerce.bankReference")}
        name="reference"
        value={reference}
        onChange={(event) => setReference(event.target.value)}
        minLength={8}
        maxLength={300}
        required
      />
      <SelectField
        label={t("commerce.reconcilePayment")}
        name="outcome"
        required
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
        disabled={!online || !outcome || reference.trim().length < 8 || reconcile.isPending}
      >
        {t("commerce.reconcilePayment")}
      </Button>
    </form>
  );
}
