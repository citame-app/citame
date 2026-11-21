import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { CalendarLiveProvider } from "~/features/admin/calendar/live-provider";
import { renderApp } from "../../../../test/render";
import { BookingPolicyForm } from "./booking-policy-form";

const originalFetch = globalThis.fetch;
const originalEventSource = globalThis.EventSource;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.EventSource = originalEventSource;
});

test("a live notice replaces an older first response still in flight", async () => {
  class LiveConnection extends EventTarget {
    static instance: LiveConnection;
    readyState = 1;
    constructor() {
      super();
      LiveConnection.instance = this;
    }
    close() {
      this.readyState = 2;
    }
  }
  globalThis.EventSource = LiveConnection as unknown as typeof EventSource;
  const old = {
    enabled: false,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 0,
    noShowBasisPoints: 0,
    trustedExempt: true,
    version: 1,
  };
  let requests = 0;
  const first = Promise.withResolvers<Response>();
  globalThis.fetch = mock(async (input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/sync/pull")) {
      expect(url.searchParams.get("bookingPolicy")).toBe("1");
      return Response.json({
        changes: [],
        refresh: ["booking_policy"],
        nextCursor: 11,
        headSeq: 11,
        hasMore: false,
      });
    }
    if (++requests === 1) return first.promise;
    return Response.json({
      generation: "initial",
      policy: { ...old, holdMinutes: 30, version: 2 },
    });
  }) as unknown as typeof fetch;
  renderApp(
    <CalendarLiveProvider>
      <BookingPolicyForm />
    </CalendarLiveProvider>,
  );
  await waitFor(() => expect(requests).toBe(1));
  await act(async () => {
    for (const seq of [10, 11])
      LiveConnection.instance.dispatchEvent(
        new MessageEvent("change", { data: JSON.stringify({ seq }) }),
      );
  });
  expect(await screen.findByLabelText(/time to pay/i)).toHaveValue("30");
  await act(async () => first.resolve(Response.json({ generation: "initial", policy: old })));
  expect(screen.getByLabelText(/time to pay/i)).toHaveValue("30");
}, 15_000);
test("owner policy changes preserve revision and convert displayed percentages to integer basis points", async () => {
  const bodies: unknown[] = [];
  const policy = {
    enabled: false,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 0,
    noShowBasisPoints: 0,
    trustedExempt: true,
    version: 7,
  };
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      generation: "initial",
      policy: { ...policy, ...(init?.body ? JSON.parse(String(init.body)).policy : {}) },
    });
  }) as unknown as typeof fetch;
  renderApp(<BookingPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Deposit (% or EUR)"), {
    target: { value: "30.5" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "Require a booking deposit" }));
  fireEvent.click(screen.getByRole("button", { name: "Save booking policy" }));
  await waitFor(() =>
    expect(bodies).toContainEqual({
      generation: "initial",
      policy: { ...policy, enabled: true, depositValue: 3050 },
    }),
  );
});
test("a live policy refresh keeps the draft until the owner reviews the new version", async () => {
  const policy = {
    enabled: false,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 0,
    noShowBasisPoints: 0,
    trustedExempt: true,
    version: 1,
  };
  let latest = policy;
  const bodies: unknown[] = [];
  globalThis.fetch = mock(async (_input, init) => {
    if (init?.method === "PUT") {
      const edited = JSON.parse(String(init.body));
      bodies.push(edited);
      latest = { ...edited.policy, version: edited.policy.version + 1 };
    }
    return Response.json({ generation: "initial", policy: latest });
  }) as unknown as typeof fetch;
  const { queryClient } = renderApp(<BookingPolicyForm />);
  fireEvent.change(await screen.findByLabelText("Deposit (% or EUR)"), { target: { value: "35" } });
  latest = { ...policy, holdMinutes: 30, version: 2 };
  await act(async () => queryClient.invalidateQueries({ queryKey: ["admin", "booking-policy"] }));
  expect(await screen.findByRole("status")).toHaveTextContent(/policy changed/i);
  expect(screen.getByLabelText("Deposit (% or EUR)")).toHaveValue("35");
  expect(screen.getByRole("button", { name: "Save booking policy" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload current policy" }));
  await waitFor(() => expect(screen.getByLabelText(/time to pay/i)).toHaveValue("30"));
  expect(screen.getByLabelText("Deposit (% or EUR)")).toHaveValue("35");
  fireEvent.click(screen.getByRole("button", { name: "Save booking policy" }));
  await waitFor(() =>
    expect(bodies).toContainEqual({
      generation: "initial",
      policy: { ...policy, depositValue: 3500, holdMinutes: 30, version: 2 },
    }),
  );
});
