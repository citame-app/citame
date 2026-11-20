import {
  type GiftCard,
  type GiftCardPurchaseInput,
  giftCardBalanceSchema,
  giftCardListSchema,
  giftCardMovementListSchema,
  giftCardPurchaseResponseSchema,
  giftCardRevealSchema,
  giftCardSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
import type { CommerceMode } from "./commerce-endpoints";

const base = (mode: CommerceMode) => `${mode === "admin" ? "/admin" : "/me"}/gift-cards`;
export function giftCardEndpoints(client: ApiClient) {
  return {
    list: (mode: CommerceMode, page = 1, search = "", status?: GiftCard["status"]) =>
      client.get(base(mode), giftCardListSchema, { query: { page, search, status } }),
    get: (id: string, mode: CommerceMode) => client.get(`${base(mode)}/${id}`, giftCardSchema),
    purchase: (input: GiftCardPurchaseInput, mode: CommerceMode) =>
      client.post(base(mode), input, giftCardPurchaseResponseSchema),
    reveal: (id: string, mode: CommerceMode) =>
      client.post(`${base(mode)}/${id}/code`, {}, giftCardRevealSchema),
    check: (code: string, mode: CommerceMode) =>
      client.post(`${base(mode)}/check`, { code }, giftCardBalanceSchema),
    movements: (id: string, mode: CommerceMode, page = 1) =>
      client.get(`${base(mode)}/${id}/movements`, giftCardMovementListSchema, { query: { page } }),
    expiry: (
      id: string,
      body: { expiresAt: string | null; version: number; reason: string },
      mode: CommerceMode,
    ) => client.patch(`${base(mode)}/${id}/expiry`, body, giftCardSchema),
    reissue: (id: string, body: { version: number; reason: string }, mode: CommerceMode) =>
      client.post(`${base(mode)}/${id}/reissue`, body, giftCardSchema),
  };
}
