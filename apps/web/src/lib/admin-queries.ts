import type { ClientListQuery } from "@sob/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./api/instance";

/** Calendar data is the busiest screen: refetch on focus and on an interval (push comes in Phase 4). */
export const CALENDAR_POLL_MS = 30_000;

export interface CalendarParams {
  from: string;
  to: string;
  staffIds?: string[];
}

export const calendarQuery = (params: CalendarParams) =>
  queryOptions({
    queryKey: ["admin", "calendar", params.from, params.to, (params.staffIds ?? []).join(",")],
    queryFn: () => api().admin.calendar(params),
    staleTime: 5_000,
    refetchInterval: CALENDAR_POLL_MS,
    refetchOnWindowFocus: true,
  });

export const adminStaffQuery = queryOptions({
  queryKey: ["admin", "staff"],
  queryFn: async () => (await api().admin.staff.list()).staff,
  staleTime: 30_000,
});

export const adminServicesQuery = queryOptions({
  queryKey: ["admin", "services"],
  queryFn: async () => (await api().admin.services.list()).services,
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

export const reportQuery = (params: { from: string; to: string; staffId?: string }) =>
  queryOptions({
    queryKey: ["admin", "report", params],
    queryFn: () => api().admin.reports(params),
    staleTime: 15_000,
  });
