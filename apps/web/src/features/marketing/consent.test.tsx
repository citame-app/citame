import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { campaignScheduledInstant } from "./campaigns";
import { MarketingConsent } from "./consent";
import { MarketingOptOut } from "./opt-out";

const id = "0198f5a0-7b1c-7000-8000-000000000100";
const nativeFetch = globalThis.fetch;
const choice = (enabled = false, version = 0) => ({
  enabled,
  version,
  source: null,
  updatedAt: null,
});
let data: { clientId: string; email: ReturnType<typeof choice>; sms: ReturnType<typeof choice> };
let writes: Record<string, unknown>[];
let loseResponse = false;
beforeEach(() => {
  data = { clientId: id, email: choice(), sms: choice() };
  writes = [];
  loseResponse = false;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path.endsWith("/marketing/opt-out")) {
      if (init?.method === "POST") {
        writes.push(JSON.parse(String(init.body)));
        return Response.json({ unsubscribed: true });
      }
      return Response.json({ channel: "email" });
    }
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      writes.push(body);
      if (data[body.channel as "email" | "sms"].version === body.version)
        data = {
          ...data,
          [body.channel]: {
            enabled: body.enabled,
            version: body.version + 1,
            source: body.source,
            updatedAt: "2026-11-17T09:00:00Z",
          },
        };
      if (loseResponse) {
        loseResponse = false;
        throw new TypeError("Lost consent acknowledgement");
      }
    }
    return Response.json(data);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = nativeFetch;
});
test("commercial permission needs a recorded source and submits the reviewed version", async () => {
  const dirty: boolean[] = [];
  renderApp(
    <MarketingConsent clientId={id} editable onDirtyChange={(value) => dirty.push(value)} />,
  );
  const checkbox = await screen.findByRole("checkbox", {
    name: "The client has authorized email offers",
  });
  expect(checkbox).not.toBeChecked();
  fireEvent.click(checkbox);
  const source = screen.getByLabelText("Source of this permission or withdrawal");
  const save = screen.getAllByRole("button", { name: "Save changes" })[0]!;
  expect(save).toBeDisabled();
  expect(writes).toHaveLength(0);
  fireEvent.change(source, { target: { value: "Signed consent at reception" } });
  fireEvent.click(save);
  await screen.findByText("Marketing preference saved");
  expect(writes).toEqual([
    { channel: "email", enabled: true, version: 0, source: "Signed consent at reception" },
  ]);
  expect(dirty).toContain(true);
  await waitFor(() => expect(dirty.at(-1)).toBe(false));
});
test("a fresh server revision cannot silently replace an unsaved permission choice", async () => {
  const { queryClient } = renderApp(<MarketingConsent clientId={id} editable />);
  fireEvent.click(
    await screen.findByRole("checkbox", { name: "The client has authorized email offers" }),
  );
  fireEvent.change(screen.getByLabelText("Source of this permission or withdrawal"), {
    target: { value: "Reception draft" },
  });
  data = { ...data, email: choice(false, 2) };
  await queryClient.invalidateQueries({ queryKey: ["marketing-consent"] });
  await screen.findByText(/profile changed/i);
  expect(
    screen.getByRole("checkbox", { name: "The client has authorized email offers" }),
  ).toBeChecked();
  expect(screen.getAllByRole("button", { name: "Save changes" })[0]).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(
    screen.getByRole("checkbox", { name: "The client has authorized email offers" }),
  ).not.toBeChecked();
  expect(writes).toHaveLength(0);
});
test("opening a commercial unsubscribe link is read-only until explicit confirmation", async () => {
  renderApp(<MarketingOptOut token="signed-fixture" />);
  const button = await screen.findByRole("button", { name: "Unsubscribe" });
  expect(writes).toHaveLength(0);
  fireEvent.click(button);
  await screen.findByText("You are unsubscribed from offers on this channel.");
  expect(writes).toEqual([{ token: "signed-fixture" }]);
});
test("scheduled campaigns use the salon timezone and reject a missing DST wall-clock time", () => {
  expect(campaignScheduledInstant("2026-11-17T10:00", "Europe/Madrid")).toBe(
    "2026-11-17T09:00:00.000Z",
  );
  expect(() => campaignScheduledInstant("2027-03-28T02:30", "Europe/Madrid")).toThrow();
});

test("a lost consent acknowledgement freezes the reviewed choice and retries the same packet", async () => {
  renderApp(<MarketingConsent clientId={id} editable />);
  const checkbox = await screen.findByRole("checkbox", {
    name: "The client has authorized email offers",
  });
  fireEvent.click(checkbox);
  fireEvent.change(screen.getByLabelText("Source of this permission or withdrawal"), {
    target: { value: "Signed reception record" },
  });
  loseResponse = true;
  fireEvent.click(screen.getAllByRole("button", { name: "Save changes" })[0]!);
  await waitFor(() => expect(writes).toHaveLength(1));
  await waitFor(() => expect(checkbox).toBeDisabled());
  expect(screen.getByLabelText("Source of this permission or withdrawal")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /retry/i }));
  await screen.findByText("Marketing preference saved");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(checkbox).toBeChecked();
  expect(checkbox).toBeEnabled();
});
