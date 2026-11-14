import { describe, expect, test } from "bun:test";
import { createApiClient } from "./client";
import { createEndpoints } from "./endpoints";

const ID = "0198f5a0-7b1c-7000-8000-000000000101";
const STAFF = "0198f5a0-7b1c-7000-8000-000000000201";

function setup(body: unknown, status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = createApiClient({
    restBase: "/api",
    authBase: "",
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  });
  return { api: createEndpoints(client).admin, calls };
}

describe("admin endpoints", () => {
  test("calendar sends the instants and the comma-separated staff filter", async () => {
    const { api, calls } = setup({
      timezone: "UTC",
      from: "2026-03-09T03:00:00.000Z",
      to: "2026-03-10T03:00:00.000Z",
      staff: [],
      appointments: [],
      timeOff: [],
      workingWindows: [],
    });
    await api.calendar({
      from: "2026-03-09T03:00:00.000Z",
      to: "2026-03-10T03:00:00.000Z",
      staffIds: [ID, STAFF],
    });
    expect(calls[0]?.url).toBe(
      `/api/appointments/calendar?from=2026-03-09T03%3A00%3A00.000Z&to=2026-03-10T03%3A00%3A00.000Z&staffIds=${ID}%2C${STAFF}`,
    );
  });

  test("clients list uses the server-side paging, search and sort params", async () => {
    const { api, calls } = setup({ page: 2, pageSize: 20, total: 0, clients: [] });
    await api.clients.list({
      page: 2,
      pageSize: 20,
      search: "ana",
      sort: "lastVisitAt",
      order: "desc",
    });
    expect(calls[0]?.url).toBe(
      "/api/admin/clients?page=2&pageSize=20&search=ana&sort=lastVisitAt&order=desc",
    );
  });

  test("replacing working hours is a PUT with the ranges", async () => {
    const { api, calls } = setup({ staffId: STAFF, hours: [], conflicts: [] });
    await api.staff.setWorkingHours(STAFF, {
      hours: [{ weekday: 1, startTime: "09:00", endTime: "17:00" }],
    });
    expect(calls[0]?.url).toBe(`/api/admin/staff/${STAFF}/working-hours`);
    expect(calls[0]?.init.method).toBe("PUT");
  });

  test("deleting time off is a DELETE that returns the conflicts it leaves", async () => {
    const { api, calls } = setup({
      timeOff: {
        id: ID,
        staffId: STAFF,
        startsAt: "2026-03-09T12:00:00.000Z",
        endsAt: "2026-03-09T13:00:00.000Z",
        reason: null,
      },
      conflicts: [],
    });
    await api.staff.deleteTimeOff(STAFF, ID);
    expect(calls[0]?.init.method).toBe("DELETE");
    expect(calls[0]?.url).toBe(`/api/admin/staff/${STAFF}/time-off/${ID}`);
  });

  test("reports pass salon-local dates and the optional staff", async () => {
    const empty = {
      from: "2026-03-01",
      to: "2026-03-02",
      timezone: "UTC",
      staffId: null,
      totals: {
        appointments: 0,
        byStatus: { booked: 0, completed: 0, cancelled: 0, no_show: 0 },
        revenueCents: 0,
        noShowRate: null,
      },
      series: [],
      topServices: [],
      perStaff: [],
    };
    const { api, calls } = setup(empty);
    await api.reports({ from: "2026-03-01", to: "2026-03-02" });
    expect(calls[0]?.url).toBe("/api/admin/reports/summary?from=2026-03-01&to=2026-03-02");
  });

  test("settings are a PATCH on /admin/settings", async () => {
    const { api, calls } = setup({
      name: "S",
      timezone: "UTC",
      slotGranularityMinutes: 15,
      minNoticeMinutes: 60,
      maxDaysAhead: 60,
      reminderFirstLeadMinutes: 1440,
      reminderSecondLeadMinutes: 120,
    });
    await api.settings.update({ minNoticeMinutes: 30 });
    expect(calls[0]?.url).toBe("/api/admin/settings");
    expect(calls[0]?.init.body).toBe('{"minNoticeMinutes":30}');
  });

  test("a 204-free delete of a client returns the confirmation", async () => {
    const { api } = setup({ id: ID, deleted: true });
    expect((await api.clients.remove(ID)).deleted).toBe(true);
  });
});
