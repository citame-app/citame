import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { EmailDelivery } from "./email-delivery-form";

const fetchBefore = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = fetchBefore;
});

test("a live refresh replaces clean settings and preserves a draft until explicit reload", async () => {
  const initialRevision = "01965683-0000-7000-8000-000000000001";
  let live = {
    revision: initialRevision,
    settings: { provider: "resend", fromEmail: "sender@example.com", fromName: "Original name" },
    serverEmailEnabled: true,
    hasSecret: true,
  };
  const sends: unknown[] = [];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith("/test")) {
      sends.push(JSON.parse(String(init?.body)));
      return Response.json({ ok: true });
    }
    return Response.json(live);
  }) as unknown as typeof fetch;
  const view = renderApp(<EmailDelivery email="owner@example.com" />);
  const input = await screen.findByLabelText("Sender name");
  expect(input).toHaveValue("Original name");

  const secondRevision = "01965683-0000-7000-8000-000000000002";
  live = {
    ...live,
    revision: secondRevision,
    settings: { ...live.settings, fromName: "New sender" },
  };
  await act(async () =>
    view.queryClient.invalidateQueries({ queryKey: ["admin", "email-delivery"] }),
  );
  await waitFor(() => expect(screen.getByLabelText("Sender name")).toHaveValue("New sender"));
  fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
  await waitFor(() => expect(sends).toEqual([{ revision: secondRevision }]));

  fireEvent.input(screen.getByLabelText("Sender name"), { target: { value: "Unsaved sender" } });
  live = {
    ...live,
    revision: "01965683-0000-7000-8000-000000000003",
    settings: { ...live.settings, fromName: "Latest sender" },
  };
  await act(async () =>
    view.queryClient.invalidateQueries({ queryKey: ["admin", "email-delivery"] }),
  );
  expect(screen.getByLabelText("Sender name")).toHaveValue("Unsaved sender");
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another session updated these settings",
  );
  expect(screen.getByRole("button", { name: "Save email settings" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload email settings" }));
  await waitFor(() => expect(screen.getByLabelText("Sender name")).toHaveValue("Latest sender"));
});
