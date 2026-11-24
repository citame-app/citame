import type { WaitlistQuery } from "@sob/contracts";
import {
  type QueryClient,
  type QueryFunctionContext,
  type QueryKey,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError } from "./api/client";
import type { CommerceMode } from "./api/commerce-endpoints";
import { api } from "./api/instance";
import { clearPrivateQueryData } from "./private-queries";

export const waitlistQueryKey = ["waitlist"] as const;
export const waitlistUserKey = (mode: CommerceMode, userId: string) =>
  [...waitlistQueryKey, mode, userId] as const;

export interface WaitlistViewer {
  userId: string;
  accessScope?: string;
}

export function clearWaitlist(
  client: QueryClient,
  mode: CommerceMode,
  userId: string,
  failingKey?: QueryKey,
) {
  return clearPrivateQueryData(client, waitlistUserKey(mode, userId), failingKey);
}

async function readWaitlist(
  { client, signal, queryKey }: QueryFunctionContext,
  mode: CommerceMode,
  viewer: WaitlistViewer,
  filters: WaitlistQuery,
  endpoints = api,
) {
  try {
    return await endpoints().waitlist.list(mode, filters, signal, viewer.accessScope);
  } catch (error) {
    if (signal.aborted || !(error instanceof ApiError) || ![401, 403].includes(error.status))
      throw error;
    // Keep other observers subscribed, while discarding cached names and counts.
    await clearWaitlist(client, mode, viewer.userId, queryKey);
    return null;
  }
}

export const waitlistQuery = (mode: CommerceMode, viewer: WaitlistViewer, filters: WaitlistQuery) =>
  queryOptions({
    queryKey: [...waitlistUserKey(mode, viewer.userId), viewer.accessScope, "list", filters],
    queryFn: (context) => readWaitlist(context, mode, viewer, filters),
  });

export const calendarWaitlistQuery = (
  viewer: WaitlistViewer,
  range: { fromDate: string; toDate: string },
  endpoints = api,
) =>
  queryOptions({
    queryKey: [...waitlistUserKey("admin", viewer.userId), viewer.accessScope, "count", range],
    queryFn: async (context) => {
      const data = await readWaitlist(
        context,
        "admin",
        viewer,
        { ...range, active: "true", pageSize: 1 },
        endpoints,
      );
      return data?.total ?? null;
    },
    refetchInterval: 15_000,
  });
