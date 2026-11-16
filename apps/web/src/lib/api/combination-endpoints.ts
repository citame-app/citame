import {
  type CombinationCreate,
  type CombinationUpdate,
  serviceCombinationSchema,
  serviceCombinationsSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function combinationEndpoints(client: ApiClient) {
  return {
    list: () => client.get("/services/combinations", serviceCombinationsSchema),
    admin: () =>
      client.get("/admin/services/combinations", serviceCombinationsSchema, { cache: "no-store" }),
    create: (input: CombinationCreate) =>
      client.post("/admin/services/combinations", input, serviceCombinationSchema),
    update: (id: string, input: CombinationUpdate) =>
      client.put(`/admin/services/combinations/${id}`, input, serviceCombinationSchema),
  };
}
