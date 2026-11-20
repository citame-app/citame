import {
  type CheckoutPrices,
  type CreateCheckoutInput,
  cashSessionSchema,
  checkoutRefundSchema,
  checkoutSchema,
  paymentCapabilitiesSchema,
  type StartPaymentInput,
  startedPaymentSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";
export type CommerceMode = "admin" | "client";
const base = (mode: CommerceMode) => (mode === "admin" ? "/admin/commerce" : "/me");
export function commerceEndpoints(client: ApiClient) {
  return {
    capabilities: (mode: CommerceMode) =>
      client.get(
        mode === "admin" ? "/admin/commerce/capabilities" : "/me/commerce/capabilities",
        paymentCapabilitiesSchema,
      ),
    list: () =>
      client.get("/admin/commerce/checkouts", z.object({ checkouts: z.array(checkoutSchema) })),
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
    cash: () =>
      client.get(
        "/admin/commerce/cash-sessions/current",
        z.object({ session: cashSessionSchema.nullable() }),
      ),
    openCash: (openingCents: number) =>
      client.post("/admin/commerce/cash-sessions", { openingCents }, cashSessionSchema),
    closeCash: (id: string, countedCents: number) =>
      client.post(`/admin/commerce/cash-sessions/${id}/close`, { countedCents }, cashSessionSchema),
    adjustCash: (input: {
      kind: "deposit" | "withdrawal";
      amountCents: number;
      reason: string;
      idempotencyKey: string;
    }) => client.post("/admin/commerce/cash-sessions/adjust", input, cashSessionSchema),
    reconcilePayment: (id: string, input: { outcome: "succeeded" | "failed"; reference: string }) =>
      client.post(
        `/admin/commerce/payments/${id}/reconcile`,
        input,
        z.object({ id: z.string(), status: z.string() }),
      ),
    refund: (
      paymentId: string,
      input: { amountCents: number; reason: string; idempotencyKey: string },
    ) => client.post(`/admin/commerce/payments/${paymentId}/refunds`, input, checkoutRefundSchema),
    executeRefund: (id: string) =>
      client.post(`/admin/commerce/refunds/${id}/execute`, {}, checkoutRefundSchema),
    reconcileRefund: (id: string, input: { outcome: "succeeded" | "failed"; reference: string }) =>
      client.post(`/admin/commerce/refunds/${id}/reconcile`, input, checkoutRefundSchema),
  };
}
