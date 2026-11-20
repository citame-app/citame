import {
  type DateShiftCommit,
  type DateShiftInput,
  dateShiftPreviewSchema,
  dateShiftResultSchema,
  dateShiftsResponseSchema,
  teamShiftWeekSchema,
} from "@sob/contracts";
import type { ApiClient } from "./client";
export function dateShiftEndpoints(client: ApiClient) {
  const base = (staffId: string) => `/admin/staff/${staffId}/date-shifts`;
  return {
    teamWeek: (week: string, signal?: AbortSignal) =>
      client.get("/admin/staff/team-shifts", teamShiftWeekSchema, { query: { week }, signal }),
    get: (staffId: string, from: string, to: string) =>
      client.get(base(staffId), dateShiftsResponseSchema, { query: { from, to } }),
    preview: (staffId: string, selection: DateShiftInput) =>
      client.post(`${base(staffId)}/preview`, selection, dateShiftPreviewSchema),
    apply: (staffId: string, input: DateShiftCommit) =>
      client.post(base(staffId), input, dateShiftResultSchema),
  };
}
