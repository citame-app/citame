import {
  type GiftCard,
  type GiftCardPurchaseInput,
  type GiftOfferOrder,
  type GiftOfferUpdate,
  giftCardBalanceSchema,
  giftCardListSchema,
  giftCardMovementListSchema,
  giftCardPurchaseResponseSchema,
  giftCardRevealSchema,
  giftCardSchema,
  giftEligibleCatalogSchema,
  giftOfferAdminListSchema,
  giftOfferSchema,
  publicGiftOfferListSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
import type { CommerceMode } from "./commerce-endpoints";

const base = (mode: CommerceMode) => `${mode === "admin" ? "/admin" : "/me"}/gift-cards`;
export function giftCardEndpoints(client: ApiClient) {
  return {
    publicOffers: () => client.get("/gift-offers", publicGiftOfferListSchema),
    offers: () => client.get("/admin/gift-cards/offers", giftOfferAdminListSchema),
    saveOffer: (id: string, update: GiftOfferUpdate) =>
      client.put(`/admin/gift-cards/offers/${id}`, update, giftOfferSchema),
    orderOffer: (order: GiftOfferOrder) =>
      client.post("/me/gift-cards/storefront", order, giftCardPurchaseResponseSchema),

    eligibleServices: (signal?: AbortSignal) =>
      client.get("/admin/gift-cards/eligible-services", giftEligibleCatalogSchema, { signal }),
    list: (
      mode: CommerceMode,
      page = 1,
      search = "",
      status?: GiftCard["status"],
      pendingOffer = false,
    ) =>
      client.get(base(mode), giftCardListSchema, {
        query: { page, search, status, pendingOffer: pendingOffer ? "1" : undefined },
      }),
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
