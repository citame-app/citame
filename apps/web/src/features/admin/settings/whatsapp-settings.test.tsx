import { afterEach, expect, mock, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
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

test("undoing a draft lets the next save use the live connection revision", async () => {
  const setup = { appId: "123456", configId: "234567", version: "v27.0" };
  const rule = { kind: "confirmation", templateId: "345678", variables: ["time"] };
  let connection = {
    revision: "a".repeat(64),
    phone: "+34 600 000 000",
    coexistence: true,
    expiresAt: null,
    rules: [rule],
  };
  const patches: unknown[] = [];
  globalThis.fetch = mock(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname.endsWith("/deliveries")) return Response.json([]);
    if (url.pathname.endsWith("/templates"))
      return Response.json([
        {
          id: rule.templateId,
          name: "Confirmation",
          language: "en",
          body: "{{1}}",
          parameters: ["1"],
          named: false,
        },
      ]);
    if (init?.method === "PATCH") {
      const patch = JSON.parse(String(init.body));
      patches.push(patch);
      connection = { ...connection, revision: "c".repeat(64), rules: patch.rules };
    }
    return Response.json({ setup, connection });
  }) as unknown as typeof fetch;
  const view = renderApp(<WhatsAppSettings />);
  const heading = await screen.findByRole("heading", { name: "Booking confirmation" });
  const section = within(heading.closest("section")!);
  const field = await section.findByLabelText("{{1}}");
  fireEvent.change(field, { target: { value: "staff" } });
  fireEvent.change(field, { target: { value: "time" } });
  connection = {
    ...connection,
    revision: "b".repeat(64),
    rules: [{ ...rule, variables: ["client"] }],
  };
  await act(async () =>
    view.queryClient.invalidateQueries({ queryKey: ["admin", "whatsapp", "connection"] }),
  );
  await waitFor(() => expect(section.getByLabelText("{{1}}")).toHaveValue("client"));
  fireEvent.change(section.getByLabelText("{{1}}"), { target: { value: "staff" } });
  fireEvent.click(screen.getByRole("button", { name: "Save automations" }));
  await waitFor(() =>
    expect(patches).toEqual([
      { revision: "b".repeat(64), rules: [{ ...rule, variables: ["staff"] }] },
    ]),
  );
});

test.each(["stale", "current"] as const)(
  "disconnecting checks a %s review and keeps delivery history",
  async (review) => {
    const setup = { appId: "123456", configId: "234567", version: "v27.0" };
    const connection = {
      phone: "+34 600 000 000",
      revision: "a".repeat(64),
      rules: [],
      coexistence: true,
      expiresAt: null,
    };
    const requests: unknown[] = [];
    globalThis.fetch = mock(async (input: URL | string, init?: RequestInit) => {
      const { pathname } = new URL(String(input), "http://localhost");
      if (pathname.endsWith("/deliveries"))
        return Response.json([
          {
            id: "01965683-0000-7000-8000-000000000001",
            kind: "confirmation",
            scheduledFor: "2026-11-21T10:00:00.000Z",
            status: "sent",
            delivery: "read",
            lastError: null,
          },
        ]);
      if (pathname.endsWith("/disconnect/reviewed")) {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json({ setup, connection: null, signupRevision: "c".repeat(64) });
      }
      if (pathname.endsWith("/templates")) return Response.json([]);
      if (requests.length > 0) return new Response(null, { status: 503 });
      return Response.json({ setup, connection });
    }) as unknown as typeof fetch;
    const view = renderApp(<WhatsAppSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect from Citame" }));
    const dialog = within(
      await screen.findByRole("dialog", { name: "Disconnect +34 600 000 000?" }),
    );
    const confirm = dialog.getByRole("button", { name: "Confirm disconnect" });
    await waitFor(() => expect(dialog.getByRole("button", { name: "Cancel" })).toHaveFocus());
    if (review === "stale") {
      await act(async () => {
        view.queryClient.setQueryData(["admin", "whatsapp", "connection"], {
          setup,
          connection: { ...connection, revision: "b".repeat(64) },
        });
        // TanStack Query publishes observer updates on the next task.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(dialog.getByRole("button", { name: "Confirm disconnect" })).toBeDisabled();
      expect(requests).toEqual([]);
    } else {
      fireEvent.click(confirm);
      expect(await screen.findByRole("button", { name: "Load Meta sign-in" })).toBeEnabled();
      expect(await screen.findByText("Read")).toBeInTheDocument();
      expect(requests).toEqual([{ revision: connection.revision }]);
    }
  },
);

test.each(["stale", "successful", "cancelled"] as const)(
  "Embedded Signup applies the result for a %s popup review",
  async (outcome) => {
    const setup = { appId: "123456", configId: "234567", version: "v27.0" };
    const original = "a".repeat(64);
    const newRevision = "b".repeat(64);
    const phone = "+34 611 000 000";
    let signupRevision = original;
    let finish: Parameters<NonNullable<Window["FB"]>["login"]>[0] | undefined;
    const previousSdk = window.FB;
    window.FB = {
      init() {},
      login(callback) {
        finish = callback;
      },
    };
    const attempts: unknown[] = [];
    globalThis.fetch = mock(async (input: URL | string, init?: RequestInit) => {
      const path = new URL(String(input), "http://localhost").pathname;
      if (path.endsWith("/deliveries") || path.endsWith("/templates")) return Response.json([]);
      if (path.endsWith("/connect/reviewed")) {
        attempts.push(JSON.parse(String(init?.body)));
        if (outcome === "successful")
          return Response.json({
            setup,
            connection: {
              phone,
              revision: newRevision,
              coexistence: true,
              expiresAt: null,
              rules: [],
            },
          });
        return Response.json(
          { error: { code: "version_conflict", message: "changed" } },
          { status: 409 },
        );
      }
      if (outcome === "successful" && attempts.length > 0)
        return new Response(null, { status: 503 });
      return Response.json({ setup, connection: null, signupRevision });
    }) as unknown as typeof fetch;
    try {
      const view = renderApp(<WhatsAppSettings />);
      fireEvent.click(await screen.findByRole("button", { name: "Load Meta sign-in" }));
      fireEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp Business" }));
      if (outcome === "cancelled") {
        await act(async () => finish?.(undefined));
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "Meta sign-in ended before the connection was completed",
        );
        expect(screen.getByRole("button", { name: "Connect WhatsApp Business" })).toBeEnabled();
        expect(attempts).toEqual([]);
        return;
      }
      if (outcome === "stale") {
        signupRevision = newRevision;
        await act(async () =>
          view.queryClient.invalidateQueries({ queryKey: ["admin", "whatsapp", "connection"] }),
        );
      }
      await act(async () => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://www.facebook.com",
            data: {
              type: "WA_EMBEDDED_SIGNUP",
              event: "FINISH",
              data: { waba_id: "456789", phone_number_id: "345678" },
            },
          }),
        );
        finish?.({ authResponse: { code: "synthetic-signup-code" } });
      });
      if (outcome === "stale") {
        expect(await screen.findByRole("alert")).toHaveTextContent(
          "The connection changed while Meta was open",
        );
      } else {
        expect(await screen.findByText(phone)).toBeInTheDocument();
      }
      expect(attempts).toEqual([
        { code: "synthetic-signup-code", wabaId: "456789", phoneId: "345678", revision: original },
      ]);
    } finally {
      window.FB = previousSdk;
    }
  },
);
