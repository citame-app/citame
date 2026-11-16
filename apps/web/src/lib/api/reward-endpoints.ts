import {
  type ApplyRewardInput,
  type BookingPromotionQuoteRequest,
  bookingPromotionQuoteSchema,
  checkoutSchema,
  type LoyaltyPolicy,
  loyaltyPolicySchema,
  loyaltyStatementSchema,
  type PromotionInput,
  promotionSchema,
  type RewardChoice,
  rewardQuoteSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";
import type { CommerceMode } from "./commerce-endpoints";

const base = (mode: CommerceMode) => (mode === "admin" ? "/admin/commerce" : "/me");
export function rewardEndpoints(client: ApiClient) {
  return {
    bookingQuote: (input: BookingPromotionQuoteRequest) =>
      client.post("/appointments/promotion-quote", input, bookingPromotionQuoteSchema),
    policy: () => client.get("/admin/rewards/policy", loyaltyPolicySchema),
    savePolicy: (input: LoyaltyPolicy) =>
      client.put("/admin/rewards/policy", input, loyaltyPolicySchema),
    statement: (mode: CommerceMode, clientId?: string, page = 1) =>
      client.get(
        mode === "client" ? "/me/rewards" : `/admin/rewards/clients/${clientId}`,
        loyaltyStatementSchema,
        { query: { page } },
      ),
    adjust: (clientId: string, input: { points: number; reason: string; idempotencyKey: string }) =>
      client.post(
        `/admin/rewards/clients/${clientId}/adjustments`,
        input,
        z.object({ id: z.string(), points: z.number().int() }),
      ),
    promotions: (page = 1, search = "", fresh = false) =>
      client.get(
        "/admin/rewards/promotions",
        z.object({
          promotions: z.array(promotionSchema),
          pagination: z.object({ page: z.number(), pageSize: z.number(), total: z.number() }),
        }),
        { query: { page, search }, cache: fresh ? "no-store" : undefined },
      ),
    savePromotion: (id: string | null, input: PromotionInput) =>
      id
        ? client.put(`/admin/rewards/promotions/${id}`, input, promotionSchema)
        : client.post("/admin/rewards/promotions", input, promotionSchema),
    quote: (id: string, choice: RewardChoice, mode: CommerceMode) =>
      client.post(`${base(mode)}/checkouts/${id}/reward/quote`, choice, rewardQuoteSchema),
    apply: (id: string, input: ApplyRewardInput, mode: CommerceMode) =>
      client.post(`${base(mode)}/checkouts/${id}/reward`, input, checkoutSchema),
    returnPoints: (id: string, reason: string, mode: CommerceMode) =>
      client.post(`${base(mode)}/checkouts/${id}/reward/return`, { reason }, checkoutSchema),
  };
}
