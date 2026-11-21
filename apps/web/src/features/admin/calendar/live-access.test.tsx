import { afterEach, expect, mock, test } from "bun:test";
import { act, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { CalendarLiveProvider } from "./live-provider";

const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
const colleagueId = "0198f5a0-7b1c-7000-8000-000000000202";
const fetchBefore = globalThis.fetch;
const eventSourceBefore = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = fetchBefore;
  globalThis.EventSource = eventSourceBefore;
});

test("live changes refresh the affected staff session without refreshing colleagues", async () => {
  class Stream extends EventTarget {
    static instance: Stream;
    readyState = 1;
    constructor() {
      super();
      Stream.instance = this;
    }
    close() {
      this.readyState = 2;
    }
    send(seq: number) {
      this.dispatchEvent(new MessageEvent("change", { data: JSON.stringify({ seq }) }));
    }
  }
  globalThis.EventSource = Stream as unknown as typeof EventSource;
  let seq = 11;
  let id = colleagueId;
  const pull = mock(async () =>
    Response.json({
      changes: [{ seq, entity: "staff", id, op: "delete", data: null }],
      nextCursor: seq,
      headSeq: seq,
      hasMore: false,
    }),
  );
  globalThis.fetch = pull as unknown as typeof fetch;
  const refreshAccess = mock(async (_signal: AbortSignal) => {});
  renderApp(
    <CalendarLiveProvider staffId={staffId} refreshAccess={refreshAccess}>
      Agenda
    </CalendarLiveProvider>,
  );
  act(() => Stream.instance.send(10));
  expect(refreshAccess).toHaveBeenCalledTimes(1);
  await act(async () => Stream.instance.send(11));
  expect(pull).toHaveBeenCalledTimes(1);
  expect(refreshAccess).toHaveBeenCalledTimes(1);

  id = staffId;
  seq = 12;
  act(() => Stream.instance.send(12));
  await waitFor(() => expect(refreshAccess).toHaveBeenCalledTimes(2));
  expect(refreshAccess.mock.calls[0]?.[0].aborted).toBe(true);
});
