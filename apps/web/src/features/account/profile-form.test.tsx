import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { ProfileForm } from "./profile-form";

const realFetch = globalThis.fetch;
let calls: { url: string; body: unknown }[];
let status: number;

beforeEach(() => {
  calls = [];
  status = 200;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { code: "internal_error", message: "x" } }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(
      JSON.stringify({
        user: { id: "u", email: "lucia@example.com", name: body?.name ?? "Lucia", role: "client" },
        staffId: null,
        clientId: "0198f5a0-7b1c-7000-8000-000000000301",
        phone: body?.phone ?? null,
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const initial = { name: "Lucia", email: "lucia@example.com", phone: null };

describe("ProfileForm", () => {
  test("shows the current details; the email is read-only", () => {
    renderApp(<ProfileForm initial={initial} onSaved={() => {}} />);
    expect(screen.getByLabelText("Full name")).toHaveValue("Lucia");
    expect(screen.getByLabelText("Phone")).toHaveAttribute("type", "tel");
    expect(screen.getByLabelText("Phone")).toHaveAttribute("autocomplete", "tel");
    expect(screen.getByLabelText("Email")).toHaveAttribute("readonly");
  });

  test("validates before sending and ties errors to the fields", async () => {
    renderApp(<ProfileForm initial={initial} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText("Full name"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Enter your name")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid phone number")).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  test("saves, reports success and hands the fresh profile to the caller", async () => {
    const onSaved = mock();
    renderApp(<ProfileForm initial={initial} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "+54 9 11 5555-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Profile saved")).toBeInTheDocument();
    expect(calls[0]?.url).toBe("/api/me");
    expect(calls[0]?.body).toEqual({ name: "Lucia", phone: "+54 9 11 5555-0000" });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  test("a server failure keeps the form and says so", async () => {
    status = 500;
    renderApp(<ProfileForm initial={initial} onSaved={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("We could not save your profile")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled());
  });
});
