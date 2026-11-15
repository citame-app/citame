import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReportSummary } from "@sob/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { ReportsView } from "./reports-view";

const ANA = "0198f5a0-7b1c-7000-8000-000000000201";
const realFetch = globalThis.fetch;
const NOW = new Date("2026-03-18T15:00:00.000Z");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const slice = (completed: number, noShow: number, revenueCents: number) => ({
  appointments: completed + noShow,
  byStatus: { booked: 0, completed, cancelled: 0, no_show: noShow },
  revenueCents,
});

let report: ReportSummary;
let urls: string[];
beforeEach(() => {
  urls = [];
  report = {
    from: "2026-02-17",
    to: "2026-03-18",
    timezone: "America/Argentina/Buenos_Aires",
    staffId: null,
    totals: { ...slice(2, 1, 2_500_000), noShowRate: 1 / 3 },
    series: [
      { date: "2026-03-09", ...slice(1, 1, 1_500_000) },
      { date: "2026-03-10", ...slice(1, 0, 1_000_000) },
    ],
    topServices: [{ serviceId: null, name: "Haircut", count: 2, revenueCents: 2_500_000 }],
    perStaff: [{ staffId: ANA, displayName: "Ana", ...slice(2, 1, 2_500_000), noShowRate: 1 / 3 }],
  };
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    urls.push(url.pathname + url.search);
    if (url.pathname === "/api/admin/reports/summary") return json(report);
    if (url.pathname === "/api/admin/staff")
      return json({
        staff: [{ id: ANA, displayName: "Ana", active: true, userId: null, serviceIds: [] }],
      });
    return json({}, 404);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const open = (
  search = { preset: "last30" } as Parameters<typeof ReportsView>[0]["search"],
  onSearchChange: (s: typeof search) => void = () => {},
  role: "owner" | "staff" = "owner",
) =>
  renderApp(<ReportsView search={search} onSearchChange={onSearchChange} role={role} now={NOW} />);

describe("ReportsView", () => {
  test("asks for the preset range in salon-local dates", async () => {
    open();
    await screen.findByRole("group", { name: "Summary" });
    expect(urls.find((u) => u.startsWith("/api/admin/reports"))).toBe(
      "/api/admin/reports/summary?from=2026-02-17&to=2026-03-18",
    );
  });

  test("summary tiles show the exact numbers", async () => {
    open();
    const tiles = await screen.findByRole("group", { name: "Summary" });
    expect(within(tiles).getByText("Appointments").nextElementSibling).toHaveTextContent("3");
    expect(within(tiles).getByText("Completed").nextElementSibling).toHaveTextContent("2");
    expect(within(tiles).getByText("Revenue").nextElementSibling).toHaveTextContent(
      /25,000|25\.000/,
    );
    expect(within(tiles).getByText("No-show rate").nextElementSibling).toHaveTextContent("33%");
  });

  test("every chart has a text summary and a data table alternative", async () => {
    open();
    const figure = await screen.findByRole("figure", { name: "Revenue per day" });
    expect(within(figure).getByText(/from completed appointments between/)).toBeInTheDocument();
    fireEvent.click(within(figure).getByRole("button", { name: "Show data table" }));
    const table = within(figure).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByText(/15,000|15\.000/)).toBeInTheDocument();
  });

  test("top services and the per-staff breakdown are tables", async () => {
    open();
    const top = await screen.findByRole("table", { name: "Top services" });
    expect(within(top).getByText("Haircut")).toBeInTheDocument();
    const staff = screen.getByRole("table", { name: "By team member" });
    expect(within(staff).getByText("Ana")).toBeInTheDocument();
    expect(within(staff).getByText("33%")).toBeInTheDocument();
  });

  test("presets and custom ranges go through the URL state", async () => {
    const onSearchChange = mock();
    open({ preset: "last30" }, onSearchChange);
    await screen.findByRole("group", { name: "Summary" });
    fireEvent.click(screen.getByRole("radio", { name: "This month" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({ preset: "thisMonth" });
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(onSearchChange).toHaveBeenLastCalledWith({
      preset: "custom",
      from: "2026-02-17",
      to: "2026-03-18",
    });
  });

  test("an invalid custom range is explained and not requested", async () => {
    open({ preset: "custom", from: "2026-03-10", to: "2026-03-01" });
    expect(
      await screen.findByText("The end date must not be before the start date"),
    ).toBeInTheDocument();
    expect(urls.some((u) => u.startsWith("/api/admin/reports"))).toBe(false);
  });

  test("the team filter is for the owner only", async () => {
    const { unmount } = open();
    expect(await screen.findByLabelText("Team member")).toBeInTheDocument();
    unmount();
    open({ preset: "last30" }, () => {}, "staff");
    await screen.findByRole("group", { name: "Summary" });
    expect(screen.queryByLabelText("Team member")).toBeNull();
  });

  test("exporting downloads the visible data as CSV", async () => {
    const created: Blob[] = [];
    const realCreate = URL.createObjectURL;
    URL.createObjectURL = ((blob: Blob) => {
      created.push(blob);
      return "blob:x";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    open();
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(await created[0]?.text()).toStartWith(
      "date,appointments,booked,completed,cancelled,no_show,revenue\r\n2026-03-09,2,0,1,0,1,15000.00",
    );
    URL.createObjectURL = realCreate;
  });

  test("an empty period is a clear empty state and the export is disabled", async () => {
    report = {
      ...report,
      totals: { ...slice(0, 0, 0), noShowRate: null },
      series: [],
      topServices: [],
      perStaff: [],
    };
    open();
    expect(await screen.findByText("No appointments in this period")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });
});
