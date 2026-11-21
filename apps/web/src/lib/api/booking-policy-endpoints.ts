import {
  bookingPolicySchema,
  type ReviewedBookingPolicy,
  reviewedBookingPolicySchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function bookingPolicyEndpoints(client: ApiClient) {
  return {
    get: () => client.get("/salon/booking-policy", bookingPolicySchema),
    admin: (signal?: AbortSignal) =>
      client.get("/admin/settings/booking-policy/reviewed", reviewedBookingPolicySchema, {
        signal,
        cache: "no-store",
      }),
    save: (input: ReviewedBookingPolicy) =>
      client.put("/admin/settings/booking-policy/reviewed", input, reviewedBookingPolicySchema),
  };
}
