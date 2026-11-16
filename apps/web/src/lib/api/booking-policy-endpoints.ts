import { type BookingPolicy, bookingPolicySchema } from "@sob/contracts";
import type { ApiClient } from "./client";
export function bookingPolicyEndpoints(client: ApiClient) {
  return {
    get: () => client.get("/salon/booking-policy", bookingPolicySchema),
    admin: () => client.get("/admin/settings/booking-policy", bookingPolicySchema),
    save: (input: BookingPolicy) =>
      client.put("/admin/settings/booking-policy", input, bookingPolicySchema),
  };
}
