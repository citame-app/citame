import { afterEach, expect, mock, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderApp } from "../../../../test/render";
import { StaffWorkReport } from "./staff-work";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("a staff work report switches periods and exports the visible days", async () => {
  const staffId = "0198f5a0-7b1c-7000-8000-000000000201";
  const totals = {
    scheduledMinutes: 240,
    blockedMinutes: 30,
    reservedMinutes: 90,
    completedMinutes: 60,
    noShowMinutes: 30,
    occupancyRate: 0.4286,
  };
  const report = {
    staffId,
    timezone: "Europe/Madrid",
    selected: {
      from: "2026-11-20",
      to: "2026-11-20",
      totals,
      days: [{ date: "2026-11-20", ...totals }],
      unavailable: [],
    },
    upcoming: {
      from: "2026-11-22",
      to: "2026-11-22",
      totals,
      days: [{ date: "2026-11-22", ...totals }],
      unavailable: [
        {
          startsAt: "2026-11-22T10:00:00.000Z",
          endsAt: "2026-11-22T10:30:00.000Z",
        },
      ],
    },
  };
  let denied = false;
  const load = mock(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    expect(url.pathname).toBe("/api/admin/reports/staff-work");
    expect(url.searchParams.get("staffId")).toBe(staffId);
    if (denied)
      return Response.json(
        { error: { code: "forbidden", message: "Scope changed" } },
        { status: 403 },
      );
    return Response.json(report);
  });
  globalThis.fetch = load as unknown as typeof fetch;
  const download = mock(() => {});
  const { queryClient } = renderApp(
    <StaffWorkReport staffId={staffId} range={report.selected} onDownload={download} />,
    {
      locale: "es-AR",
    },
  );
  expect(await screen.findByRole("table", { name: "Fechas seleccionadas" })).toBeInTheDocument();
  expect(screen.getByText("Sin franjas no disponibles")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Próximos 14 días" }));
  expect(screen.getByRole("table", { name: "Próximos 14 días" })).toBeInTheDocument();
  expect(screen.getByText(/11:00.*11:30/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Descargar CSV diario" }));
  expect(download).toHaveBeenCalledWith(
    expect.stringContaining("2026-11-22,240,30,90,60,30,0.4286"),
    "staff-work-2026-11-22-2026-11-22.csv",
  );
  denied = true;
  await queryClient.invalidateQueries({ queryKey: ["admin", "report", "staff-work"] });
  await waitFor(() => expect(screen.queryByRole("table", { name: "Próximos 14 días" })).toBeNull());
  expect(screen.queryByRole("button", { name: "Descargar CSV diario" })).toBeNull();
});
