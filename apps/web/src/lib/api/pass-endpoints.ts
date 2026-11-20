import {
  type BenefitPurchaseInput,
  benefitPlanListSchema,
  benefitPlanSchema,
  benefitRefundQuoteResponseSchema,
  type CreateBenefitPlanInput,
  passContractSchema,
  passEligibilitySchema,
  passListSchema,
  passPeriodsSchema,
  passPurchaseResponseSchema,
  type UpdateBenefitPlanInput,
} from "@sob/contracts";
import type { ApiClient } from "./client";
import type { CommerceMode } from "./commerce-endpoints";

const base = (mode: CommerceMode) => `${mode === "admin" ? "/admin" : "/me"}/passes`;
export function passEndpoints(client: ApiClient) {
  return {
    plans: (manage = false) =>
      client.get(manage ? "/admin/benefit-plans" : "/benefit-plans", benefitPlanListSchema),
    createPlan: (input: CreateBenefitPlanInput) =>
      client.post("/admin/benefit-plans", input, benefitPlanSchema),
    updatePlan: (id: string, input: UpdateBenefitPlanInput) =>
      client.patch(`/admin/benefit-plans/${id}`, input, benefitPlanSchema),
    list: (
      mode: CommerceMode,
      page = 1,
      search = "",
      kind?: "package" | "membership",
      clientId?: string,
    ) => client.get(base(mode), passListSchema, { query: { page, search, kind, clientId } }),
    get: (id: string, mode: CommerceMode) => client.get(`${base(mode)}/${id}`, passContractSchema),
    periods: (id: string, mode: CommerceMode, page = 1) =>
      client.get(`${base(mode)}/${id}/periods`, passPeriodsSchema, { query: { page } }),
    purchase: (input: BenefitPurchaseInput, mode: CommerceMode) =>
      client.post(base(mode), input, passPurchaseResponseSchema),
    renew: (id: string, key: string, mode: CommerceMode) =>
      client.post(`${base(mode)}/${id}/renew`, { idempotencyKey: key }, passPurchaseResponseSchema),
    cancel: (id: string, input: { version: number; reason: string }, mode: CommerceMode) =>
      client.post(`${base(mode)}/${id}/cancel`, input, passContractSchema),
    eligible: (checkoutId: string, mode: CommerceMode) =>
      client.get(`${base(mode)}/eligible`, passEligibilitySchema, { query: { checkoutId } }),
    refundQuote: (periodId: string, paymentId: string, unitCount: number) =>
      client.post(
        "/admin/passes/refund-quote",
        { periodId, paymentId, unitCount },
        benefitRefundQuoteResponseSchema,
      ),
  };
}
