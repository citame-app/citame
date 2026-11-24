import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { VisitCheckout } from "./visit-checkout";

const id = (suffix: string) => `0198f5a0-7b1c-7000-8000-000000000${suffix}`;
const groupId = id("100");
const first = id("101");
const second = id("102");
const createdAt = "2026-03-09T12:00:00.000Z";
const token = "a".repeat(64);
const receipt = (id: string, appointmentId: string, totalCents: number) => ({
  id,
  appointmentId,
  clientId: null,
  currency: "EUR",
  status: "open",
  subtotalCents: totalCents,
  discountCents: 0,
  tipCents: 0,
  taxCents: 0,
  totalCents,
  paidCents: 0,
  refundedCents: 0,
  balanceCents: totalCents,
  lines: [],
  payments: [],
  createdAt,
});
const appointments = [
  {
    appointmentId: first,
    staffId: id("105"),
    staffName: "Ana",
    serviceNames: ["Style"],
    startsAt: createdAt,
    status: "completed",
    settledExternally: false,
    receipt: receipt(id("103"), first, 1200),
  },
  {
    appointmentId: second,
    staffId: id("106"),
    staffName: "Bea",
    serviceNames: ["Cut"],
    startsAt: createdAt,
    status: "completed",
    settledExternally: false,
    receipt: receipt(id("104"), second, 1900),
  },
];
const storageKey = `citame:visit-payment:owner:itinerary:${groupId}`;
const realFetch = globalThis.fetch;
let commands: { path: string; body: unknown }[];
let responseMode: "lost" | "success" | "conflict";

beforeEach(() => {
  sessionStorage.removeItem(storageKey);
  commands = [];
  responseMode = "lost";
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith("/checkouts"))
      return Response.json({
        groupId,
        source: "itinerary",
        appointments,
        paymentReview: {
          token,
          totalCents: 3100,
          allocations: [
            { receiptId: id("103"), amountCents: 1200 },
            { receiptId: id("104"), amountCents: 1900 },
          ],
        },
      });
    if (!path.endsWith("/payments")) return Response.json({}, { status: 404 });
    commands.push({ path, body: JSON.parse(String(init?.body)) });
    if (responseMode === "lost") throw new TypeError("Response lost");
    if (responseMode === "conflict")
      return Response.json(
        { error: { code: "version_conflict", message: "Balance changed" } },
        { status: 409 },
      );
    return Response.json(
      {
        id: id("107"),
        method: "external_card",
        totalCents: 3100,
        allocations: [
          { paymentId: id("108"), receiptId: id("103"), amountCents: 1200 },
          { paymentId: id("109"), receiptId: id("104"), amountCents: 1900 },
        ],
      },
      { status: 201 },
    );
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sessionStorage.removeItem(storageKey);
});

function open(appointmentId = first, actorId = "owner") {
  const app = renderApp(
    <VisitCheckout
      appointmentId={appointmentId}
      groupId={groupId}
      actorId={actorId}
      source="itinerary"
      role="owner"
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review visit payment" }));
  return app;
}

test("an uncertain payment can be recovered from another appointment in the same visit", async () => {
  const initial = open();
  await screen.findByText(/Ana ·/u);
  expect(screen.getByText(/Bea ·/u)).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Card — already collected externally" }));
  fireEvent.click(screen.getByRole("button", { name: "Record payment · €31" }));
  await screen.findByText(/result is still unconfirmed/u);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.body).toEqual({
    method: "external_card",
    reviewToken: token,
    idempotencyKey: expect.any(String),
  });
  initial.unmount();

  responseMode = "success";
  open(second);
  fireEvent.click(await screen.findByRole("button", { name: "Retry same payment · €31" }));
  await screen.findByText("Visit payment recorded · €31");
  expect(screen.getByText("€12 recorded")).toBeTruthy();
  expect(screen.getByText("€19 recorded")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "View receipt" })).toHaveLength(2);
  expect(commands[1]?.path).toContain(second);
  expect(commands[1]?.body).toEqual(commands[0]?.body);
  expect(sessionStorage.getItem(storageKey)).toBeNull();
});

test("a stale review requires a new explicit review before paying again", async () => {
  responseMode = "conflict";
  open();
  fireEvent.click(await screen.findByRole("button", { name: "Record payment · €31" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Record payment · €31" })).toBeNull();
  expect(sessionStorage.getItem(storageKey)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review current balances" }));
  await screen.findByRole("button", { name: "Record payment · €31" });
  expect(commands).toHaveLength(1);
});

test("another operator cannot recover the saved payment command", async () => {
  sessionStorage.setItem(
    storageKey,
    JSON.stringify({
      totalCents: 3100,
      request: { method: "cash", reviewToken: token, idempotencyKey: id("101") },
    }),
  );
  open(second, "someone-else");
  await screen.findByRole("button", { name: "Record payment · €31" });
  expect(screen.queryByRole("button", { name: "Retry same payment · €31" })).toBeNull();
  await waitFor(() => expect(commands).toHaveLength(0));
});

test("no payment is sent if the browser cannot retain the original command", async () => {
  open();
  const button = await screen.findByRole("button", { name: "Record payment · €31" });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  if (!descriptor) throw new Error("Missing browser storage in the test environment");
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get() {
      throw new DOMException("Storage blocked", "SecurityError");
    },
  });
  try {
    fireEvent.click(button);
    await screen.findByText(/could not save the retry details/u);
    expect(commands).toHaveLength(0);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", descriptor);
  }
});
