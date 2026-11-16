import {
  type DateShiftCommit,
  type DateShiftInput,
  dateShiftPreviewSchema,
  dateShiftResultSchema,
  dateShiftsResponseSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function dateShiftEndpoints(client: ApiClient) {
  const base = (staffId: string) => `/admin/staff/${staffId}/date-shifts`;
  return {
    get: (staffId: string, from: string, to: string) =>
      client.get(base(staffId), dateShiftsResponseSchema, { query: { from, to } }),
    preview: (staffId: string, selection: DateShiftInput) =>
      client.post(`${base(staffId)}/preview`, selection, dateShiftPreviewSchema),
    apply: (staffId: string, input: DateShiftCommit) =>
      client.post(base(staffId), input, dateShiftResultSchema),
  };
}
