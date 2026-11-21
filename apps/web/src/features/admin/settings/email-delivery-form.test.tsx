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
    if (String(url).endsWith("/test-reviewed")) {
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

test("a delayed save acknowledgement cannot replace a newer live revision", async () => {
  const revision = "01965683-0000-7000-8000-000000000004";
  let live = {
    revision,
    settings: { provider: "resend", fromEmail: "sender@example.com", fromName: "Original" },
    serverEmailEnabled: true,
    hasSecret: true,
  };
  const saved = {
    ...live,
    revision: "01965683-0000-7000-8000-000000000005",
    settings: { ...live.settings, fromName: "First edit" },
  };
  const response = Promise.withResolvers<Response>();
  const save = mock(() => response.promise);
  globalThis.fetch = mock(async (_url: string | URL | Request, init?: RequestInit) =>
    init?.method === "PUT" ? save() : Response.json(live),
  ) as unknown as typeof fetch;
  const view = renderApp(<EmailDelivery email="owner@example.com" />);
  fireEvent.input(await screen.findByLabelText("Sender name"), { target: { value: "First edit" } });
  const form = screen.getByRole("button", { name: "Save email settings" }).closest("form");
  if (!form) throw new Error("The save button must belong to the email settings form");
  fireEvent.submit(form);
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  live = {
    ...saved,
    revision: "01965683-0000-7000-8000-000000000006",
    settings: { ...saved.settings, fromName: "Newer edit from Desktop" },
  };
  await act(async () =>
    view.queryClient.invalidateQueries({ queryKey: ["admin", "email-delivery"] }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Another session updated these settings",
  );
  response.resolve(Response.json(saved));
  await waitFor(() =>
    expect(screen.getByLabelText("Sender name")).toHaveValue("Newer edit from Desktop"),
  );
});
