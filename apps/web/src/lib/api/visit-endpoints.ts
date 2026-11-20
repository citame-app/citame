import {
  type VisitAvailability,
  type VisitCreate,
  visitSchema,
  visitSlotsSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function visitEndpoints(client: ApiClient) {
  return {
    availability: (input: VisitAvailability) =>
      client.post("/services/visit-availability", input, visitSlotsSchema),
    create: (input: VisitCreate) => client.post("/appointments/visits", input, visitSchema),
    get: (id: string) => client.get(`/appointments/visits/${id}`, visitSchema),
  };
}
