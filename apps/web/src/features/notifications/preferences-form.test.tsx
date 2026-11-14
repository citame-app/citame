import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { PreferencesForm } from "./preferences-form";

const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body: unknown }[];
let prefs: Record<string, unknown>;
let failPatch: boolean;

const base = {
  locale: null,
  email: { transactional: true, reminder: true },
  sms: { transactional: false, reminder: false },
  hasEmail: true,
  hasPhone: true,
};

beforeEach(() => {
  calls = [];
  failPatch = false;
  prefs = structuredClone(base);
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(input), body });
    if (method === "PATCH") {
      if (failPatch) {
        return new Response(JSON.stringify({ error: { code: "internal_error", message: "x" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      prefs = {
        ...prefs,
        ...(body.locale !== undefined ? { locale: body.locale } : {}),
        email: { ...(prefs.email as object), ...body.email },
        sms: { ...(prefs.sms as object), ...body.sms },
      };
    }
    return new Response(JSON.stringify(prefs), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("PreferencesForm", () => {
  test("shows email on and SMS off by default, in labelled groups", async () => {
    renderApp(<PreferencesForm />);
    const email = await screen.findByRole("group", { name: "Email" });
    expect(email).toBeInTheDocument();
    const emailBoxes = email.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...emailBoxes].map((b) => b.checked)).toEqual([true, true]);
    const sms = screen.getByRole("group", { name: "Text messages (SMS)" });
    const smsBoxes = sms.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    expect([...smsBoxes].map((b) => b.checked)).toEqual([false, false]);
    expect(screen.getByText(/Reply STOP/)).toBeInTheDocument();
  });

  test("sends only what changed", async () => {
    renderApp(<PreferencesForm />);
    const reminders = await screen.findAllByLabelText("Reminders before your appointment");
    fireEvent.click(reminders[0] as HTMLElement); // email reminders off
    fireEvent.change(screen.getByLabelText("Language of messages"), { target: { value: "es-AR" } });
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toContain("/me/notification-preferences");
    expect(patch?.body).toEqual({ locale: "es-AR", email: { reminder: false } });
    expect(await screen.findByText("Preferences saved")).toBeInTheDocument();
  });

  test("turning SMS on is explicit and disabled without a phone number", async () => {
    prefs = { ...structuredClone(base), hasPhone: false };
    renderApp(<PreferencesForm />);
    const sms = await screen.findByRole("group", { name: "Text messages (SMS)" });
    for (const box of sms.querySelectorAll<HTMLInputElement>("input[type=checkbox]")) {
      expect(box).toBeDisabled();
    }
    expect(
      screen.getByText("Add a phone number in your profile to receive text messages."),
    ).toBeInTheDocument();
  });

  test("keeps the save button disabled until something changes and reports failures", async () => {
    failPatch = true;
    renderApp(<PreferencesForm />);
    const save = await screen.findByRole("button", { name: "Save preferences" });
    expect(save).toBeDisabled();
    fireEvent.click(
      (await screen.findAllByLabelText("Reminders before your appointment"))[0] as HTMLElement,
    );
    expect(save).toBeEnabled();
    fireEvent.click(save);
    expect(await screen.findByText("We could not save your preferences")).toBeInTheDocument();
  });

  test("renders Argentine Spanish", async () => {
    renderApp(<PreferencesForm />, { locale: "es-AR" });
    expect(await screen.findByRole("group", { name: "Correo electrónico" })).toBeInTheDocument();
    expect(screen.getByLabelText("Idioma de los mensajes")).toBeInTheDocument();
  });
});
