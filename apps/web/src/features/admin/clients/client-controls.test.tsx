import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ClientControlsEditor } from "./client-controls";

const id = "0198f5a0-7b1c-7000-8000-000000000100";
const realFetch = globalThis.fetch;
let saved: Record<string, unknown>;
let sent: Record<string, unknown>[];
beforeEach(() => {
  sent = [];
  saved = {
    clientId: id,
    tags: ["vip"],
    bookingAccess: "normal",
    reason: null,
    version: 1,
    canManageBookingAccess: true,
  };
  globalThis.fetch = mock(async (_input: unknown, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      saved = { ...saved, ...body, version: Number(saved.version) + 1 };
    }
    return Response.json(saved);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
test("tags and booking access use a revision and an explicit private reason", async () => {
  renderApp(<ClientControlsEditor clientId={id} />);
  await screen.findByLabelText("Client tags");
  fireEvent.change(screen.getByLabelText("Booking access"), { target: { value: "blocked" } });
  expect(screen.getByRole("button", { name: "Save client controls" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Access change reason"), {
    target: { value: "Review required" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save client controls" }));
  await waitFor(() =>
    expect(sent).toContainEqual({
      version: 1,
      bookingAccess: "blocked",
      reason: "Review required",
    }),
  );
});
test("professional users can edit tags without an access escalation control", async () => {
  saved.canManageBookingAccess = false;
  renderApp(<ClientControlsEditor clientId={id} />);
  await screen.findByLabelText("Client tags");
  expect(screen.queryByLabelText("Booking access")).toBeNull();
  fireEvent.change(screen.getByLabelText("Client tags"), { target: { value: "vip, color" } });
  fireEvent.click(screen.getByRole("button", { name: "Save client controls" }));
  await waitFor(() => expect(sent).toContainEqual({ version: 1, tags: ["vip", "color"] }));
});
test("a remote revision preserves the draft and requires an explicit reload", async () => {
  const view = renderApp(<ClientControlsEditor clientId={id} />);
  await screen.findByLabelText("Client tags");
  fireEvent.change(screen.getByLabelText("Client tags"), { target: { value: "unsaved" } });
  saved = { ...saved, tags: ["remote"], version: 2 };
  await act(async () => {
    await view.queryClient.invalidateQueries({ queryKey: ["client-controls", id] });
  });
  await screen.findByText(/This profile changed elsewhere/);
  expect(screen.getByLabelText("Client tags")).toHaveValue("unsaved");
  expect(screen.getByRole("button", { name: "Save client controls" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload client controls" }));
  expect(screen.getByLabelText("Client tags")).toHaveValue("remote");
});
test("duplicate normalized labels explain why saving is unavailable", async () => {
  renderApp(<ClientControlsEditor clientId={id} />);
  await screen.findByLabelText("Client tags");
  fireEvent.change(screen.getByLabelText("Client tags"), { target: { value: "vip, VIP" } });
  expect(
    await screen.findByText(
      "Use up to 20 different labels of 1–40 characters, separated by commas.",
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Save client controls" })).toBeDisabled();
});
