import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { SettingsView } from "./settings-view";

const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let settings: Record<string, unknown>;
let patches: unknown[];
let fail: boolean;

beforeEach(() => {
  patches = [];
  fail = false;
  settings = {
    name: "Sisters of Beauty",
    timezone: "America/Argentina/Buenos_Aires",
    slotGranularityMinutes: 15,
    minNoticeMinutes: 60,
    maxDaysAhead: 60,
    reminderFirstLeadMinutes: 1440,
    reminderSecondLeadMinutes: 120,
  };
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname !== "/api/admin/settings") return json({}, 404);
    if (init?.method === "PATCH") {
      patches.push(JSON.parse(String(init.body)));
      if (fail) return json({ error: { code: "internal_error", message: "x" } }, 500);
      settings = { ...settings, ...JSON.parse(String(init.body)) };
    }
    return json(settings);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("SettingsView reminders", () => {
  test("shows the lead times and saves a change; an empty field turns a reminder off", async () => {
    renderApp(<SettingsView />);
    const first = await screen.findByLabelText("First reminder (minutes before)");
    expect(first).toHaveValue("1440");
    expect(screen.getByLabelText("Second reminder (minutes before)")).toHaveValue("120");
    fireEvent.change(first, { target: { value: "2880" } });
    fireEvent.change(screen.getByLabelText("Second reminder (minutes before)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(patches).toEqual([
        { reminderFirstLeadMinutes: 2880, reminderSecondLeadMinutes: null },
      ]),
    );
  });

  test("rejects lead times outside the allowed range", async () => {
    renderApp(<SettingsView />);
    fireEvent.change(await screen.findByLabelText("First reminder (minutes before)"), {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(
      await screen.findByText("Enter minutes between 5 and 20160, or leave empty"),
    ).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });
});

describe("SettingsView", () => {
  test("pauses online bookings independently of the other settings", async () => {
    renderApp(<SettingsView section="booking" />);
    const toggle = await screen.findByRole("switch", { name: "Accept new online bookings" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(patches).toEqual([{ onlineBookingEnabled: false }]));
    expect(toggle).not.toBeChecked();
  });

  test("loads the current values", async () => {
    renderApp(<SettingsView />);
    expect(await screen.findByLabelText("Salon name")).toHaveValue("Sisters of Beauty");
    expect(screen.getByLabelText("Timezone")).toHaveValue("America/Argentina/Buenos_Aires");
    expect(screen.getByLabelText("Time slot interval")).toHaveValue("15");
    expect(screen.getByLabelText("Minimum notice (minutes)")).toHaveValue("60");
    expect(screen.getByLabelText("Booking window (days ahead)")).toHaveValue("60");
    expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled();
  });

  test("saves only the changed fields and confirms", async () => {
    renderApp(<SettingsView />);
    fireEvent.change(await screen.findByLabelText("Minimum notice (minutes)"), {
      target: { value: "120" },
    });
    fireEvent.change(screen.getByLabelText("Time slot interval"), { target: { value: "30" } });
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(patches).toEqual([{ slotGranularityMinutes: 30, minNoticeMinutes: 120 }]),
    );
    expect(await screen.findByText("Settings saved")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save settings" })).toBeDisabled(),
    );
  });

  test("invalid values are explained and nothing is sent", async () => {
    renderApp(<SettingsView />);
    fireEvent.change(await screen.findByLabelText("Salon name"), { target: { value: "  " } });
    fireEvent.change(screen.getByLabelText("Booking window (days ahead)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Enter the salon name")).toBeInTheDocument();
    expect(screen.getByText("Enter a number of days between 1 and 365")).toBeInTheDocument();
    expect(patches).toHaveLength(0);
  });

  test("a server failure keeps the edits", async () => {
    fail = true;
    renderApp(<SettingsView />);
    fireEvent.change(await screen.findByLabelText("Salon name"), { target: { value: "New name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText(/Could not save the settings/)).toBeInTheDocument();
    expect(screen.getByLabelText("Salon name")).toHaveValue("New name");
  });
});
