import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { OptOutView } from "./opt-out-view";

const realFetch = globalThis.fetch;
let calls: { method: string; url: string; body: unknown }[];
let optedOut: boolean;
let valid: boolean;

beforeEach(() => {
  calls = [];
  optedOut = false;
  valid = true;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (!valid) {
      return new Response(JSON.stringify({ error: { code: "validation_error", message: "bad" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "POST") optedOut = true;
    return new Response(JSON.stringify({ channel: "email", category: "reminder", optedOut }), {
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OptOutView", () => {
  test("describes the action first and changes nothing on load", async () => {
    renderApp(<OptOutView token="tok-123456789" />);
    expect(
      await screen.findByRole("heading", { name: "Stop appointment reminders" }),
    ).toBeInTheDocument();
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls[0]?.url).toContain("token=tok-123456789");
  });

  test("confirming posts the token and shows the result", async () => {
    renderApp(<OptOutView token="tok-123456789" />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop reminders" }));
    expect(
      await screen.findByRole("heading", { name: "Reminders turned off" }),
    ).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ token: "tok-123456789" });
  });

  test("an already opted-out link says so", async () => {
    optedOut = true;
    renderApp(<OptOutView token="tok-123456789" />);
    expect(await screen.findByText("Reminders are already turned off.")).toBeInTheDocument();
  });

  test("an invalid or missing token shows a clear message", async () => {
    valid = false;
    renderApp(<OptOutView token="broken-token-1" />);
    expect(
      await screen.findByRole("heading", { name: "This link is not valid" }),
    ).toBeInTheDocument();
    renderApp(<OptOutView token={undefined} />);
    await waitFor(() =>
      expect(screen.getAllByRole("heading", { name: "This link is not valid" }).length).toBe(2),
    );
  });

  test("renders Argentine Spanish", async () => {
    renderApp(<OptOutView token="tok-123456789" />, { locale: "es-AR" });
    expect(
      await screen.findByRole("heading", { name: "Dejar de recibir recordatorios" }),
    ).toBeInTheDocument();
  });
});
