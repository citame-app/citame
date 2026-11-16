import {
  type ResourceCreate,
  type ResourceUpdate,
  resourceListSchema,
  resourceSchema,
  type ServiceResourceInput,
  serviceResourcesSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function resourceEndpoints(client: ApiClient) {
  return {
    list: () => client.get("/admin/resources", resourceListSchema),
    create: (input: ResourceCreate) => client.post("/admin/resources", input, resourceSchema),
    update: (id: string, input: ResourceUpdate) =>
      client.put(`/admin/resources/${id}`, input, resourceSchema),
    requirements: (id: string) =>
      client.get(`/admin/services/${id}/resources`, serviceResourcesSchema),
    saveRequirements: (id: string, input: ServiceResourceInput) =>
      client.put(`/admin/services/${id}/resources`, input, serviceResourcesSchema),
  };
}
