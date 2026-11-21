import type { ClientListQuery } from "@sob/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api/instance";

/** SSE refreshes the web calendar; focus/interval remain the fallback when disconnected. */
export const CALENDAR_POLL_MS = 30_000;

export interface CalendarParams {
  from: string;
  to: string;
  staffIds?: string[];
}

export const calendarQuery = (params: CalendarParams, endpoints = api) =>
  queryOptions({
    queryKey: ["admin", "calendar", params.from, params.to, (params.staffIds ?? []).join(",")],
    queryFn: ({ signal }) => endpoints().admin.calendar(params, signal),
    staleTime: 5_000,
    refetchInterval: CALENDAR_POLL_MS,
    refetchOnWindowFocus: true,
  });

export const staffQuery = (endpoints = api) =>
  queryOptions({
    queryKey: ["admin", "staff"],
    queryFn: async ({ signal }) => (await endpoints().admin.staff.list(signal)).staff,
    staleTime: 30_000,
  });
export const adminStaffQuery = staffQuery();

export const teamShiftWeekKey = ["admin", "team-shifts"] as const;

export const calendarWaitlistQuery = (
  range: { fromDate: string; toDate: string },
  endpoints = api,
) =>
  queryOptions({
    queryKey: ["waitlist", "calendar-count", range],
    queryFn: async () =>
      (await endpoints().waitlist.list("admin", { ...range, active: "true", pageSize: 1 })).total,
    refetchInterval: 15_000,
  });

export const adminServicesQuery = queryOptions({
  queryKey: ["admin", "services"],
  queryFn: async ({ signal }) => (await api().admin.services.list(signal)).services,
  staleTime: 30_000,
});

export const adminSettingsQuery = queryOptions({
  queryKey: ["admin", "settings"],
  queryFn: () => api().admin.settings.get(),
});

export const clientsQuery = (query: Partial<ClientListQuery>) =>
  queryOptions({
    queryKey: ["admin", "clients", query],
    queryFn: () => api().admin.clients.list(query),
    staleTime: 10_000,
    placeholderData: (previous) => previous,
  });

export const clientDetailQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "client", id],
    queryFn: () => api().admin.clients.get(id),
  });

export const workingHoursQuery = (staffId: string) =>
  queryOptions({
    queryKey: ["admin", "working-hours", staffId],
    queryFn: () => api().admin.staff.workingHours(staffId),
  });

export const timeOffQuery = (staffId: string) =>
  queryOptions({
    queryKey: ["admin", "time-off", staffId],
    queryFn: async () => (await api().admin.staff.timeOff(staffId)).timeOff,
  });

export const reportQuery = (params: {
  from: string;
  to: string;
  staffId?: string;
  currency?: string;
}) =>
  queryOptions({
    queryKey: ["admin", "report", params],
    queryFn: () => api().admin.reports(params),
    staleTime: 15_000,
  });
