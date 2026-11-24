import { queryOptions } from "@tanstack/react-query";
import { api } from "./api/instance";

export const oauthAccountQueryKey = ["oauth", "account"] as const;
export const oauthAccountKey = (userId: string) => [...oauthAccountQueryKey, userId] as const;

export const oauthConnectionsQuery = (userId: string) =>
  queryOptions({
    queryKey: [...oauthAccountKey(userId), "connections"],
    queryFn: ({ signal }) => api().oauthConnections.list(signal),
  });

export const desktopDevicesQuery = (userId: string) =>
  queryOptions({
    queryKey: [...oauthAccountKey(userId), "desktop-devices"],
    queryFn: ({ signal }) => api().desktopDevices.list(signal),
    refetchInterval: 30_000,
  });
