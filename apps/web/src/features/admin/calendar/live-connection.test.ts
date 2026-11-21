import { afterEach, expect, mock, test } from "bun:test";
import type { SyncChange, SyncPullResponse } from "@sob/contracts";
import { waitFor } from "@testing-library/react";
import { ApiError } from "~/lib/api/client";
import { connectCalendarLive, type LiveSource } from "./live-connection";
import { liveQueryKeys } from "./live-queries";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function liveSource(): LiveSource & {
  readyState: number;
  send: (seq: number, generation?: string) => void;
} {
  let listener: (event: MessageEvent<string>) => void = () => {};
  return {
    readyState: 0,
    onopen: null,
    onerror: null,
    addEventListener: (_type, fn) => {
      listener = fn;
    },
    close: mock(),
    send: (seq, generation) =>
      listener(new MessageEvent("change", { data: JSON.stringify({ seq, generation }) })),
  };
}
function harness(
  pull: (since: number, signal: AbortSignal) => Promise<SyncPullResponse>,
  fallbackMs = 60000,
) {
  const sources: ReturnType<typeof liveSource>[] = [];
  const open = mock(() => {
    const source = liveSource();
    sources.push(source);
    return source;
  });
  const onChanges = mock();
  const onRefresh = mock();
  const onConnection = mock();
  const onAccessExpired = mock();
  const close = connectCalendarLive({
    open,
    pull,
    onChanges,
    onRefresh,
    onConnection,
    onAccessExpired,
    fallbackMs,
  });
  cleanups.push(close);
  const source = sources[0];
  if (!source) throw new Error("Expected the first EventSource");
  return {
    source,
    sources,
    open,
    onChanges,
    onRefresh,
    onConnection,
    onAccessExpired,
    close,
    send: source.send,
  };
}
const change = (seq: number): SyncChange => ({
  seq,
  entity: "appointment",
  id: "hidden",
  op: "delete",
  data: null,
});
const response = (seq: number, head = seq): SyncPullResponse => ({
  changes: [change(seq)],
  nextCursor: seq,
  headSeq: head,
  hasMore: seq < head,
});

test("service and team changes refresh the catalogue used by an open appointment form", () => {
  for (const entity of ["service", "service_staff"] as const) {
    expect([...liveQueryKeys([entity])]).toContainEqual(["appointment-catalog"]);
  }
});

test("resource changes refresh requirements and booking availability", () => {
  const keys = [...liveQueryKeys(["resource_catalogue"])];
  expect(keys).toContainEqual(["admin", "resources"]);
  expect(keys).toContainEqual(["admin", "calendar"]);
  expect(keys).toContainEqual(["availability"]);
});

test("combination updates and qualification changes refresh combination listings", () => {
  for (const entity of ["service_combinations", "service", "service_staff", "staff"] as const) {
    expect([...liveQueryKeys([entity])]).toContainEqual(["combinations"]);
  }
});

test("initial connection does not replay history; pages and repeated nudges advance once", async () => {
  const pull = mock(async (since: number) => response(since + 1, 12));
  const h = harness(pull);
  h.send(10);
  expect(pull).not.toHaveBeenCalled();
  expect(h.onChanges).not.toHaveBeenCalled();
  h.send(12);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledTimes(2));
  expect(pull.mock.calls.map(([since]) => since)).toEqual([10, 11]);
  h.send(12);
  h.send(11);
  expect(pull).toHaveBeenCalledTimes(2);
});

test("a nudge received during an in-flight pull is not lost", async () => {
  let resolve: (value: SyncPullResponse) => void = () => {};
  const pull = mock((since: number) =>
    since === 10
      ? new Promise<SyncPullResponse>((done) => {
          resolve = done;
        })
      : Promise.resolve(response(12)),
  );
  const h = harness(pull);
  h.send(10);
  h.send(11);
  h.send(12);
  expect(pull).toHaveBeenCalledTimes(1);
  resolve(response(11));
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledTimes(2));
  expect(pull.mock.calls.map(([since]) => since)).toEqual([10, 11]);
});

test("a restored generation discards an old in-flight page even when its cursor is higher", async () => {
  const current = Promise.withResolvers<SyncPullResponse>();
  const pull = mock((since: number) =>
    since === 10 ? current.promise : Promise.resolve({ ...response(4), generation: "restored" }),
  );
  const h = harness(pull);
  h.send(10, "initial");
  h.send(11, "initial");
  h.send(3, "restored");
  h.send(4, "restored");
  current.resolve({ ...response(11), generation: "initial" });
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([change(4)], []));
  expect(h.onChanges).toHaveBeenCalledTimes(1);
  expect(h.onRefresh).toHaveBeenCalledTimes(2);
  expect(pull.mock.calls.map(([since]) => since)).toEqual([10, 3]);
});

test("a failed pull retries from the same cursor and closing aborts outstanding requests", async () => {
  const pull = mock(async (_since: number, _signal: AbortSignal) => {
    if (pull.mock.calls.length === 1) throw new Error("offline");
    return response(11);
  });
  const h = harness(pull, 15);
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledTimes(1));
  expect(pull.mock.calls.slice(0, 2).map(([since]) => since)).toEqual([10, 10]);
  h.close();
  expect(pull.mock.calls[0]?.[1].aborted).toBe(true);
  expect(h.source.close).toHaveBeenCalled();
});

test("authorization failures close the stream and suppress further processing", async () => {
  const pull = mock(async () => {
    throw new ApiError("forbidden", 403, "Forbidden");
  });
  const h = harness(pull);
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.source.close).toHaveBeenCalled());
  h.send(12);
  expect(pull).toHaveBeenCalledTimes(1);
  expect(h.onChanges).not.toHaveBeenCalled();
  expect(h.onAccessExpired).toHaveBeenCalledTimes(1);
});

test("a marker-only page refreshes cash even without replica rows", async () => {
  const pull = mock(async () => ({ ...response(11), changes: [], refresh: ["commerce"] as const }));
  const h = harness(async () => {
    const page = await pull();
    return { ...page, refresh: [...page.refresh] };
  });
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["commerce"]));
  expect([...liveQueryKeys(["commerce"])]).toContainEqual(["commerce"]);
  expect([...liveQueryKeys(["client"])]).toContainEqual(["admin", "clients"]);
  h.send(11);
  expect(pull).toHaveBeenCalledTimes(1);
});

test("a review request marker refreshes the invitation list without invalidating other views", async () => {
  const h = harness(async () => ({ ...response(11), changes: [], refresh: ["review_requests"] }));
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["review_requests"]));
  expect([...liveQueryKeys(["review_requests"])]).toEqual([
    ["reviews", "requests"],
    ["reviews", "admin"],
  ]);
});

test("an email delivery marker refreshes only the owner email settings query", async () => {
  const h = harness(async () => ({ ...response(11), changes: [], refresh: ["email_delivery"] }));
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["email_delivery"]));
  expect([...liveQueryKeys(["email_delivery"])]).toEqual([["admin", "email-delivery"]]);
});

test("promotion invalidation refreshes offers and their creative sources", () => {
  expect([...liveQueryKeys(["promotions"])]).toEqual([
    ["rewards", "promotions"],
    ["creative", "promotions"],
  ]);
});

test("marketing invalidation refreshes the campaign views", () => {
  expect([...liveQueryKeys(["marketing"])]).toEqual([["marketing"]]);
});

test("a WhatsApp marker refreshes deliveries and leaves the rule editor query alone", async () => {
  const h = harness(async () => ({ ...response(11), changes: [], refresh: ["whatsapp_desk"] }));
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["whatsapp_desk"]));
  expect([...liveQueryKeys(["whatsapp_desk"])]).toEqual([["admin", "whatsapp", "deliveries"]]);
});

test("a WhatsApp settings marker refreshes only the saved connection and rules", async () => {
  const h = harness(async () => ({ ...response(11), changes: [], refresh: ["whatsapp_settings"] }));
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["whatsapp_settings"]));
  expect([...liveQueryKeys(["whatsapp_settings"])]).toEqual([["admin", "whatsapp", "connection"]]);
});

test("a portfolio marker refreshes the gallery without refetching the calendar", async () => {
  const h = harness(async () => ({ ...response(11), changes: [], refresh: ["portfolio"] }));
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([], ["portfolio"]));
  expect([...liveQueryKeys(["portfolio"])]).toEqual([["portfolio"]]);
});

test("intake nudges target directories and histories without replacing answers being edited", async () => {
  const h = harness(async () => ({
    ...response(11),
    changes: [],
    refresh: ["intake_forms", "intake_records"],
  }));
  h.send(10);
  h.send(11);
  await waitFor(() =>
    expect(h.onChanges).toHaveBeenCalledWith([], ["intake_forms", "intake_records"]),
  );
  expect([...liveQueryKeys(["intake_forms", "intake_records"])]).toEqual([
    ["intake", "admin"],
    ["intake", "history"],
  ]);
});

test("an SSE reconnect reconciles even when there is no new nudge", async () => {
  const pull = mock(async () => response(11));
  const h = harness(pull);
  h.send(10);
  h.source.onopen?.(new Event("open"));
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([change(11)], []));
  expect(pull).toHaveBeenCalledTimes(1);
});

test("active queries refresh even when the first SSE event never arrives", async () => {
  const pull = mock(async () => response(1));
  const h = harness(pull, 15);
  await waitFor(() => expect(h.onRefresh).toHaveBeenCalled());
  expect(h.onChanges).not.toHaveBeenCalled();
  expect(pull).not.toHaveBeenCalled();
});

test("the fallback leaves a native reconnect alone and pulls from the old cursor after a terminal close", async () => {
  const pull = mock(async (_since: number) => response(11));
  const h = harness(pull, 50);
  await waitFor(() => expect(h.onRefresh).toHaveBeenCalled());
  expect(h.open).toHaveBeenCalledTimes(1);

  h.send(10);
  h.source.readyState = 2;
  h.source.onerror?.(new Event("error"));
  await waitFor(() => expect(h.open).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([change(11)], []));
  expect(pull.mock.calls[0]?.[0]).toBe(10);
  h.source.onopen?.(new Event("open"));
  expect(h.onConnection).not.toHaveBeenCalledWith(true);
  h.sources[1]?.onopen?.(new Event("open"));
  expect(h.onConnection).toHaveBeenCalledWith(true);
});

test("pull rate limits defer nudges and fallback polling and retry from the same cursor", async () => {
  const times: number[] = [];
  const pull = mock(async (_since: number) => {
    times.push(performance.now());
    if (times.length === 1) throw new ApiError("rate_limited", 429, "Too many requests", 1);
    return response(12);
  });
  const h = harness(pull, 50);
  h.send(10);
  h.send(11);
  await waitFor(() => expect(h.onConnection).toHaveBeenCalledWith(false));
  h.send(12);
  h.source.onopen?.(new Event("open"));
  expect(pull).toHaveBeenCalledTimes(1);

  await waitFor(() => expect(h.onChanges).toHaveBeenCalledWith([change(12)], []), {
    timeout: 2500,
  });
  expect(pull.mock.calls.slice(0, 2).map(([since]) => since)).toEqual([10, 10]);
  expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(990);
});
