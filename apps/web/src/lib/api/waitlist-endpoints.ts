import {
  type WaitlistAccept,
  type WaitlistInput,
  type WaitlistPolicy,
  type WaitlistQuery,
  waitlistAcceptedSchema,
  waitlistEntrySchema,
  waitlistListSchema,
  waitlistPolicySchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
import type { CommerceMode } from "./commerce-endpoints";

const base = (mode: CommerceMode) => (mode === "admin" ? "/admin/waitlist" : "/me/waitlist");
export function waitlistEndpoints(client: ApiClient) {
  return {
    list: (mode: CommerceMode, query: WaitlistQuery = {}, signal?: AbortSignal) =>
      client.get(base(mode), waitlistListSchema, { query: { ...query }, signal }),
    join: (
      mode: CommerceMode,
      input: WaitlistInput & { clientId?: string; importedEntryId?: string },
    ) => client.post(base(mode), input, waitlistEntrySchema),
    savePolicy: (input: WaitlistPolicy) =>
      client.put("/admin/waitlist/policy", input, waitlistPolicySchema),
    cancel: (mode: CommerceMode, id: string, version: number) =>
      client.post(`${base(mode)}/${id}/cancel`, { version }, waitlistEntrySchema),
    decline: (
      mode: CommerceMode,
      id: string,
      input: { version: number; offerId: string; requeue: boolean },
    ) => client.post(`${base(mode)}/${id}/decline`, input, waitlistEntrySchema),
    accept: (mode: CommerceMode, id: string, input: WaitlistAccept) =>
      client.post(`${base(mode)}/${id}/accept`, input, waitlistAcceptedSchema),
  };
}
