import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { WhatsAppSettings } from "./whatsapp-settings";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("previews a professional and time and saves the chosen reminder mapping", async () => {
  const patches: unknown[] = [];
  const setup = { appId: "123456", configId: "234567", version: "v27.0" };
  const revision = "a".repeat(64);
  const connection = {
    revision,
    phone: "+34 600 000 000",
    coexistence: true,
    expiresAt: null,
    rules: [],
  };
  globalThis.fetch = mock(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/deliveries")) return Response.json([]);
    if (url.pathname.endsWith("/templates"))
      return Response.json([
        {
          id: "345678",
          name: "recordatorio",
          language: "es_ES",
          body: "Tu cita es a las {{1}} con {{2}}.",
          parameters: ["1", "2"],
          named: false,
        },
      ]);
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      return Response.json({
        setup,
        connection: { ...connection, revision: "b".repeat(64), rules: patch.rules },
      });
    }
    return Response.json({ setup, connection });
  }) as unknown as typeof fetch;
  renderApp(<WhatsAppSettings />);
  const heading = await screen.findByRole("heading", { name: "First reminder" });
  const section = within(heading.closest("section")!);
  await section.findByRole("option", { name: "recordatorio · es_ES" });
  fireEvent.change(section.getByLabelText("Approved utility template"), {
    target: { value: "345678" },
  });
  fireEvent.change(section.getByLabelText("{{1}}"), { target: { value: "time" } });
  expect(screen.getByRole("button", { name: "Save automations" })).toBeDisabled();
  fireEvent.change(section.getByLabelText("{{2}}"), { target: { value: "staff" } });
  expect(section.getByText("Tu cita es a las 16:00 con Natalia.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save automations" }));
  await waitFor(() =>
    expect(patches).toEqual([
      {
        revision,
        rules: [{ kind: "reminder_24h", templateId: "345678", variables: ["time", "staff"] }],
      },
    ]),
  );
});
