import {
  type CampaignCreate,
  type CampaignQuery,
  type CampaignQueue,
  type CampaignTestEmail,
  type CampaignUpdate,
  campaignCapabilitySchema,
  campaignComparisonSchema,
  campaignDeliveriesSchema,
  campaignListSchema,
  campaignPreviewSchema,
  campaignSchema,
  campaignTestEmailReceiptSchema,
  type MarketingConsentInput,
  marketingConsentSchema,
} from "@sob/contracts";
import { z } from "zod";
import type { ApiClient } from "./client";

const base = "/admin/marketing/campaigns";
export function marketingEndpoints(client: ApiClient) {
  return {
    capabilities: () => client.get("/admin/marketing/capabilities", campaignCapabilitySchema),
    list: (query: Partial<CampaignQuery> = {}) => client.get(base, campaignListSchema, { query }),
    compare: (ids: string[]) =>
      client.get(`${base}/comparison`, campaignComparisonSchema, { query: { ids: ids.join(",") } }),
    get: (id: string) => client.get(`${base}/${id}`, campaignSchema),
    create: (input: CampaignCreate) => client.post(base, input, campaignSchema),
    update: (id: string, input: CampaignUpdate) =>
      client.patch(`${base}/${id}`, input, campaignSchema),
    preview: (id: string) => client.get(`${base}/${id}/preview`, campaignPreviewSchema),
    testEmail: (id: string, input: CampaignTestEmail) =>
      client.post(`${base}/${id}/test-email`, input, campaignTestEmailReceiptSchema),
    queue: (id: string, input: CampaignQueue) =>
      client.post(`${base}/${id}/queue`, input, campaignSchema),
    cancel: (id: string, version: number) =>
      client.post(`${base}/${id}/cancel`, { version }, campaignSchema),
    deliveries: (id: string, query: Partial<CampaignQuery> = {}) =>
      client.get(`${base}/${id}/deliveries`, campaignDeliveriesSchema, { query }),
    consent: (id: string) =>
      client.get(`/admin/clients/${id}/marketing-consent`, marketingConsentSchema),
    setConsent: (id: string, input: MarketingConsentInput) =>
      client.patch(`/admin/clients/${id}/marketing-consent`, input, marketingConsentSchema),
    ownConsent: () => client.get("/me/marketing-consent", marketingConsentSchema),
    setOwnConsent: (input: MarketingConsentInput) =>
      client.patch("/me/marketing-consent", input, marketingConsentSchema),
    optOutPreview: (token: string) =>
      client.get("/marketing/opt-out", z.object({ channel: z.enum(["email", "sms"]) }), {
        query: { token },
      }),
    optOut: (token: string) =>
      client.post("/marketing/opt-out", { token }, z.object({ unsubscribed: z.literal(true) })),
  };
}
