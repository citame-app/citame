import {
  type AppointmentSeriesCreate,
  type AppointmentSeriesInput,
  appointmentSeriesPreviewSchema,
  appointmentSeriesSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function seriesEndpoints(client: ApiClient) {
  return {
    preview: (input: AppointmentSeriesInput) =>
      client.post("/appointments/series/preview", input, appointmentSeriesPreviewSchema),
    create: (input: AppointmentSeriesCreate) =>
      client.post("/appointments/series", input, appointmentSeriesSchema),
    get: (id: string) => client.get(`/appointments/series/${id}`, appointmentSeriesSchema),
  };
}
