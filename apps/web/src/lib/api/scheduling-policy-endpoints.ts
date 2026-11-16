import {
  adminServiceSchema,
  type ServiceProcessingInput,
  type StaffCapacityInput,
  staffCapacitySchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function schedulingPolicyEndpoints(client: ApiClient) {
  return {
    capacity: (id: string) =>
      client.get(`/admin/staff/${id}/capacity`, staffCapacitySchema, { cache: "no-store" }),
    setCapacity: (id: string, input: StaffCapacityInput) =>
      client.put(`/admin/staff/${id}/capacity`, input, staffCapacitySchema),
    setProcessing: (id: string, input: ServiceProcessingInput) =>
      client.put(`/admin/services/${id}/processing`, input, adminServiceSchema),
  };
}
