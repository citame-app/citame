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
  return { api: createEndpoints(client), calls };
}

describe("endpoints", () => {
  test("availability sends comma-separated service ids and the optional professional", async () => {
    const { api, calls } = setup({ date: "2026-03-09", timezone: "UTC", slots: [] });
    await api.availability({ serviceIds: [ID, STAFF], staffId: STAFF, date: "2026-03-09" });
    expect(calls[0]?.url).toBe(
      `/api/availability?serviceIds=${ID}%2C${STAFF}&staffId=${STAFF}&date=2026-03-09`,
    );
  });

  test("availability without a professional omits staffId", async () => {
    const { api, calls } = setup({ date: "2026-03-09", timezone: "UTC", slots: [] });
    await api.availability({ serviceIds: [ID], date: "2026-03-09" });
    expect(calls[0]?.url).not.toContain("staffId");
  });

  test("lists appointments in a window with the page size", async () => {
    const { api, calls } = setup({ appointments: [], page: 1, pageSize: 50, total: 0 });
    await api.appointments.list({
      from: "2026-03-01T00:00:00.000Z",
      to: "2026-04-01T00:00:00.000Z",
    });
    expect(calls[0]?.url).toContain("/api/appointments?from=2026-03-01T00%3A00%3A00.000Z");
  });

  test("cancelling patches the status with the current version", async () => {
    const appointment = {
      id: ID,
      staffId: STAFF,
      clientId: ID,
      startsAt: "2026-03-09T12:00:00.000Z",
      endsAt: "2026-03-09T13:00:00.000Z",
      status: "cancelled",
      notes: null,
      version: 2,
      services: [],
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
    };
    const { api, calls } = setup(appointment);
    const result = await api.appointments.cancel(ID, 1);
    expect(result.status).toBe("cancelled");
    expect(calls[0]?.url).toBe(`/api/appointments/${ID}`);
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(calls[0]?.init.body).toBe('{"version":1,"status":"cancelled"}');
  });

  test("sign in posts credentials to the Better Auth route and tolerates its extra fields", async () => {
    const { api, calls } = setup({ redirect: false, token: "t", user: { id: "u" } });
    await api.auth.signIn({ email: "a@example.com", password: "long enough pw" });
    expect(calls[0]?.url).toBe("/api/auth/sign-in/email");
    expect(calls[0]?.init.body).toBe('{"email":"a@example.com","password":"long enough pw"}');
  });
});
