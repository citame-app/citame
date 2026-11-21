import {
  errorResponseSchema,
  type SyncMutation,
  type SyncPullQuery,
  type SyncPullResponse,
  type SyncPushResponse,
  syncPullResponseSchema,
  syncPushResponseSchema,
} from "@sob/contracts";
import { type Actor, type ApiTest, json } from "./helpers";

export const mid = () => Bun.randomUUIDv7();
export const uuid = () => Bun.randomUUIDv7();

export async function pull(
  t: ApiTest,
  who: Actor | null,
  query: Partial<SyncPullQuery> = {},
): Promise<SyncPullResponse> {
  const params = new URLSearchParams();
  if (query.since !== undefined) params.set("since", String(query.since));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.catalogColors) params.set("catalogColors", query.catalogColors);
  if (query.reviewRequests) params.set("reviewRequests", query.reviewRequests);
  if (query.intakeViews) params.set("intakeViews", query.intakeViews);
  if (query.resourceCatalogue) params.set("resourceCatalogue", query.resourceCatalogue);
  const res = await json(t.app, `/sync/pull?${params}`, "GET", undefined, who?.cookie);
  if (res.status !== 200) throw new Error(`pull failed: ${res.status} ${await res.text()}`);
  return syncPullResponseSchema.parse(await res.json());
}

/** Follows `hasMore` until the log is drained; returns every change and the final cursor. */
export async function pullAll(t: ApiTest, who: Actor, since = 0, limit = 50) {
  const changes: SyncPullResponse["changes"] = [];
  let cursor = since;
  for (;;) {
    const page = await pull(t, who, { since: cursor, limit });
    if (page.nextCursor < cursor) throw new Error("cursor went backwards");
    changes.push(...page.changes);
    cursor = page.nextCursor;
    if (!page.hasMore) return { changes, cursor };
  }
}

export async function push(
  t: ApiTest,
  who: Actor | null,
  mutations: unknown[],
  deviceId = "test-device",
): Promise<{ status: number; body: SyncPushResponse }> {
  const res = await json(t.app, "/sync/push", "POST", { deviceId, mutations }, who?.cookie);
  const body = await res.json();
  if (res.status !== 200) return { status: res.status, body: body as SyncPushResponse };
  return { status: res.status, body: syncPushResponseSchema.parse(body) };
}

export async function errorCodeOf(res: Response) {
  return errorResponseSchema.parse(await res.json()).error.code;
}

export function mutation<K extends SyncMutation["kind"]>(
  kind: K,
  payload: Extract<SyncMutation, { kind: K }>["payload"],
  overrides: { mutationId?: string; createdAt?: string } = {},
) {
  return {
    mutationId: overrides.mutationId ?? mid(),
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    kind,
    payload,
  };
}
