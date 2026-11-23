import {
  type CombinationCreate,
  type CombinationUpdate,
  serviceCombinationSchema,
  serviceCombinationsSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function combinationEndpoints(client: ApiClient) {
  return {
    list: () =>
      client.get("/services/combinations", serviceCombinationsSchema, {
        query: { fixedTerms: "1" },
      }),
    forBooking: () =>
      client.get("/appointments/combinations", serviceCombinationsSchema, { cache: "no-store" }),
    admin: () =>
      client.get("/admin/services/combinations", serviceCombinationsSchema, {
        cache: "no-store",
        query: { fixedTerms: "1" },
      }),
    create: (input: CombinationCreate) =>
      client.post("/admin/services/combinations", input, serviceCombinationSchema),
    update: (id: string, input: CombinationUpdate) =>
      client.put(`/admin/services/combinations/${id}`, input, serviceCombinationSchema),
  };
}
