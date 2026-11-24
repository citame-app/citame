import {
  type UserRole,
  type VisitCheckout as VisitCheckoutData,
  type VisitPaymentInput,
  visitPaymentInputSchema,
} from "@sob/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "~/components/ui/button";
import { useOnline } from "~/components/ui/states";
import { useI18n } from "~/i18n/react";
import { ApiError } from "~/lib/api/client";
import { api } from "~/lib/api/instance";
import { formatMoney, formatTime } from "~/lib/format";
import { CheckoutPanel } from "./checkout-panel";
import { invalidateCommerce } from "./invalidate";

const savedPaymentSchema = z.object({
  request: visitPaymentInputSchema,
  totalCents: z.number().int().positive(),
});
type SavedPayment = z.infer<typeof savedPaymentSchema>;

function recoverPayment(key: string): SavedPayment | null {
  try {
    const saved = savedPaymentSchema.safeParse(JSON.parse(sessionStorage.getItem(key) ?? "null"));
    return saved.success ? saved.data : null;
  } catch {
    return null;
  }
}

export function VisitCheckout({
  appointmentId,
  groupId,
  source,
  actorId,
  role,
}: {
  appointmentId: string;
  groupId: string;
  source: VisitCheckoutData["source"];
  actorId: string;
  role: UserRole;
}) {
  const { t, locale, timeZone } = useI18n();
  const online = useOnline();
  const queries = useQueryClient();
  const sectionId = useId();
  const key = `citame:visit-payment:${encodeURIComponent(actorId)}:${source}:${groupId}`;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(() => recoverPayment(key));
  const [receiptId, setReceiptId] = useState<string>();
  const [method, setMethod] = useState<VisitPaymentInput["method"]>("cash");
  const inFlight = useRef(false);
  const prepare = useMutation({
    mutationFn: () => api().commerce.prepareVisit(appointmentId),
  });
  const clear = (request: VisitPaymentInput) => {
    setPending(null);
    try {
      if (recoverPayment(key)?.request.idempotencyKey === request.idempotencyKey)
        sessionStorage.removeItem(key);
    } catch {
      /* The retry remains scoped to this tab when storage is unavailable. */
    }
  };
  const pay = useMutation({
    mutationFn: (request: VisitPaymentInput) => api().commerce.payVisit(appointmentId, request),
    onSuccess: (_result, request) => {
      clear(request);
      void invalidateCommerce(queries);
    },
    onError: (error, request) => {
      if (
        error instanceof ApiError &&
        error.status < 500 &&
        ![401, 403, 404, 408, 429].includes(error.status)
      ) {
        clear(request);
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const review = prepare.data?.paymentReview;
  const amount = pending?.totalCents ?? review?.totalCents;
  const money = (cents: number) => formatMoney(cents, "EUR", locale);
  const refresh = () => {
    setReceiptId(undefined);
    pay.reset();
    prepare.mutate();
  };
  const submit = () => {
    if (!online || inFlight.current || (!pending && (!review || pay.isError))) return;
    const draft =
      pending ??
      (review && {
        request: { method, reviewToken: review.token, idempotencyKey: crypto.randomUUID() },
        totalCents: review.totalCents,
      });
    if (!draft) return;
    setPending(draft);
    inFlight.current = true;
    try {
      sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {
      /* Keep the original command available in memory. */
    }
    pay.mutate(draft.request);
  };

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-expanded={open}
        aria-controls={sectionId}
        disabled={pay.isPending || (!online && !open && !pending)}
        onClick={() => {
          setOpen(!open);
          if (!open && !pending && !pay.isSuccess) refresh();
        }}
      >
        {t(open ? "commerce.visit.hide" : "commerce.visit.review")}
      </Button>
      <section id={sectionId} hidden={!open} aria-labelledby={`${sectionId}-title`}>
        {open && (
          <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
            <h3 id={`${sectionId}-title`} className="font-display text-lg font-semibold">
              {t("commerce.visit.title")}
            </h3>
            {receiptId ? (
              <>
                <Button type="button" variant="secondary" disabled={!online} onClick={refresh}>
                  {t("commerce.visit.back")}
                </Button>
                <CheckoutPanel id={receiptId} mode="admin" role={role} />
              </>
            ) : (
              <>
                {prepare.isPending && <p role="status">{t("admin.loading")}</p>}
                {prepare.isError && !pending && (
                  <p role="alert" className="text-danger-fg">
                    {t("commerce.visit.prepareError")}
                  </p>
                )}
                {prepare.data && (
                  <ul className="divide-y divide-line">
                    {prepare.data.appointments.map((part) => {
                      const receipt = part.receipt;
                      const due = receipt?.payableCents ?? receipt?.balanceCents ?? 0;
                      const payable = part.status !== "cancelled" && !part.settledExternally;
                      const allocated = pay.data?.allocations.find(
                        (item) => item.receiptId === receipt?.id,
                      );
                      return (
                        <li key={part.appointmentId} className="space-y-1 py-3">
                          <div className="flex flex-wrap items-baseline justify-between gap-2">
                            <p className="font-medium">
                              {part.staffName} · {formatTime(part.startsAt, timeZone, locale)}
                            </p>
                            <span className="text-sm tabular-nums">
                              {part.status === "cancelled"
                                ? t("calendar.status.cancelled")
                                : part.settledExternally
                                  ? t("commerce.visit.externallySettled")
                                  : allocated
                                    ? t("commerce.visit.recordedPart", {
                                        amount: money(allocated.amountCents),
                                      })
                                    : payable && receipt?.status === "open" && due > 0
                                      ? money(due)
                                      : receipt
                                        ? t(`commerce.status.${receipt.status}`)
                                        : "—"}
                            </span>
                          </div>
                          {receipt && (
                            <p className="text-sm text-muted">
                              {receipt.lines.map((line) => line.description).join(" · ")}
                            </p>
                          )}
                          {receipt && payable && !pending && !pay.isPending && (
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => setReceiptId(receipt.id)}
                            >
                              {t("commerce.details")}
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                {pay.data && (
                  <p role="status" className="font-medium text-success-fg">
                    {t("commerce.visit.recorded", { amount: money(pay.data.totalCents) })}
                  </p>
                )}
                {prepare.data && !review && !pending && !pay.data && (
                  <p className="text-sm text-muted">{t("commerce.visit.noPayment")}</p>
                )}
                {pay.isError && !pending && (
                  <p role="alert" className="text-danger-fg">
                    {t("commerce.visit.changed")}
                  </p>
                )}
                {!online && !pay.data && (
                  <p role="status" className="text-sm text-muted">
                    {t("commerce.visit.reconnect")}
                  </p>
                )}
                {(prepare.isError ||
                  (pay.isError && !pending) ||
                  (prepare.data && !review && !pending && !pay.data)) && (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!online || prepare.isPending}
                    onClick={refresh}
                  >
                    {t("commerce.visit.reload")}
                  </Button>
                )}
                {amount !== undefined && !pay.data && (!pay.isError || pending) && (
                  <form
                    aria-labelledby={`${sectionId}-title`}
                    className="space-y-3 border-t border-line pt-4"
                    method="post"
                    onSubmit={(event) => {
                      event.preventDefault();
                      submit();
                    }}
                  >
                    {pending ? (
                      <p role="status" className="text-sm text-muted">
                        {t(pay.isPending ? "commerce.visit.recording" : "commerce.visit.uncertain")}
                      </p>
                    ) : (
                      <fieldset className="space-y-1">
                        <legend className="font-medium">{t("commerce.method")}</legend>
                        {(["cash", "external_card"] as const).map((value) => (
                          <label key={value} className="flex min-h-12 items-center gap-2 text-sm">
                            <input
                              type="radio"
                              name="method"
                              value={value}
                              checked={method === value}
                              onChange={() => setMethod(value)}
                            />
                            {t(`commerce.${value}`)}
                          </label>
                        ))}
                      </fieldset>
                    )}
                    <Button type="submit" disabled={!online || pay.isPending}>
                      {t(pending ? "commerce.visit.retry" : "commerce.visit.record", {
                        amount: money(amount),
                      })}
                    </Button>
                  </form>
                )}
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
