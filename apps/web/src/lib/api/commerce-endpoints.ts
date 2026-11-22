import {
  type BankReconciliation,
  bankPaymentReconciliationResponseSchema,
  type CheckoutListQuery,
  type CheckoutPrices,
  type CreateCheckoutInput,
  cashSessionSchema,
  checkoutListSchema,
  checkoutRefundSchema,
  checkoutSchema,
  hostedPaymentFormSchema,
  type ImportedPriceReview,
  type ImportedSettlement,
  type ImportedUnpaidReview,
  importedPartialPaymentResponseSchema,
  importedSettlementResponseSchema,
  importedUnpaidReviewResponseSchema,
  paymentCapabilitiesSchema,
  type StartPaymentInput,
  startedPaymentSchema,
  unpaidAppointmentsSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";
export type CommerceMode = "admin" | "client";
const base = (mode: CommerceMode) => (mode === "admin" ? "/admin/commerce" : "/me");
export function commerceEndpoints(client: ApiClient) {
  return {
    unpaid: (query: { from: string; to: string }) =>
      client.get("/admin/commerce/unpaid", unpaidAppointmentsSchema, {
        query: { ...query, booksyPaymentReview: "1" },
      }),
    reviewImportedPrice: (id: string, input: ImportedPriceReview) =>
      client.put(
        `/admin/commerce/appointments/${id}/imported-price`,
        input,
        z.object({ ok: z.literal(true) }),
      ),
    confirmImportedSettlement: (id: string, input: ImportedSettlement) =>
      client.put(
        `/admin/commerce/appointments/${id}/imported-settlement`,
        input,
        importedSettlementResponseSchema,
      ),
    confirmImportedPartialPayment: (id: string, input: ImportedSettlement) =>
      client.put(
        `/admin/commerce/appointments/${id}/imported-partial-payment`,
        input,
        importedPartialPaymentResponseSchema,
      ),
    confirmImportedUnpaid: (id: string, input: ImportedUnpaidReview) =>
      client.put(
        `/admin/commerce/appointments/${id}/imported-unpaid`,
        input,
        importedUnpaidReviewResponseSchema,
      ),
    capabilities: (mode: CommerceMode) =>
      client.get(
        mode === "admin" ? "/admin/commerce/capabilities" : "/me/commerce/capabilities",
        paymentCapabilitiesSchema,
      ),
    list: (query: Partial<CheckoutListQuery> = {}, signal?: AbortSignal) =>
      client.get("/admin/commerce/checkouts", checkoutListSchema, { query, signal }),
    create: (input: CreateCheckoutInput, mode: CommerceMode = "admin") =>
      client.post(`${base(mode)}/checkouts`, input, checkoutSchema),
    finalizePrices: (id: string, input: CheckoutPrices) =>
      client.put(`/admin/commerce/checkouts/${id}/prices`, input, checkoutSchema),
    get: (id: string, mode: CommerceMode) =>
      client.get(`${base(mode)}/checkouts/${id}`, checkoutSchema),
    byOrder: (order: string) =>
      client.get(`/me/payments/by-order/${encodeURIComponent(order)}`, checkoutSchema),
    void: (id: string, mode: CommerceMode) =>
      client.post(`${base(mode)}/checkouts/${id}/void`, {}, checkoutSchema),
    pay: (id: string, input: StartPaymentInput, mode: CommerceMode) =>
      client.post(`${base(mode)}/checkouts/${id}/payments`, input, startedPaymentSchema),
    continueBankPayment: (checkoutId: string, paymentId: string, mode: CommerceMode) =>
      client.post(
        `${base(mode)}/checkouts/${checkoutId}/payments/${paymentId}/continue`,
        {},
        hostedPaymentFormSchema,
      ),
    cash: () =>
      client.get(
        "/admin/commerce/cash-sessions/current",
        z.object({ session: cashSessionSchema.nullable() }),
      ),
    openCash: (openingCents: number, sessionId: string) =>
      client.post("/admin/commerce/cash-sessions", { openingCents, sessionId }, cashSessionSchema),
    closeCash: (id: string, countedCents: number, reviewedExpectedCents: number) =>
      client.post(
        `/admin/commerce/cash-sessions/${id}/close`,
        { countedCents, reviewedExpectedCents },
        cashSessionSchema,
      ),
    adjustCash: (input: {
      sessionId: string;
      kind: "deposit" | "withdrawal";
      amountCents: number;
      reason: string;
      idempotencyKey: string;
    }) => client.post("/admin/commerce/cash-sessions/adjust", input, cashSessionSchema),
    reconcilePayment: (id: string, input: BankReconciliation) =>
      client.post(
        `/admin/commerce/payments/${id}/reconcile`,
        input,
        bankPaymentReconciliationResponseSchema,
      ),
    refund: (
      paymentId: string,
      input: { amountCents: number; reason: string; idempotencyKey: string },
    ) => client.post(`/admin/commerce/payments/${paymentId}/refunds`, input, checkoutRefundSchema),
    executeRefund: (id: string) =>
      client.post(`/admin/commerce/refunds/${id}/execute`, {}, checkoutRefundSchema),
    cancelRefund: (id: string) =>
      client.post(`/admin/commerce/refunds/${id}/cancel`, {}, checkoutRefundSchema),
    reconcileRefund: (id: string, input: { outcome: "succeeded" | "failed"; reference: string }) =>
      client.post(`/admin/commerce/refunds/${id}/reconcile`, input, checkoutRefundSchema),
  };
}
