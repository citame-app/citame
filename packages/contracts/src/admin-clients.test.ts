import { describe, expect, test } from "bun:test";
import {
  adminClientSchema,
  clientDetailResponseSchema,
  clientListQuerySchema,
  listClientsResponseSchema,
  updateClientRequestSchema,
} from "./index";

const uuid = "0198f5a0-7b1c-7000-8000-000000000001";
const uuid2 = "0198f5a0-7b1c-7000-8000-000000000002";

describe("client list query", () => {
  test("applies defaults and coerces numbers from the query string", () => {
    expect(clientListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 20,
      sort: "name",
      order: "asc",
    });
    expect(clientListQuerySchema.parse({ page: "3", pageSize: "50" })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
  });

  test("accepts search and the three sort keys", () => {
    expect(clientListQuerySchema.parse({ search: " mar " }).search).toBe("mar");
    for (const sort of ["name", "createdAt", "lastVisitAt"]) {
      expect(clientListQuerySchema.safeParse({ sort, order: "desc" }).success).toBe(true);
    }
  });

  test("rejects bad paging and unknown sort keys", () => {
    for (const bad of [
      { page: "0" },
      { page: "1.5" },
      { pageSize: "0" },
      { pageSize: "101" },
      { sort: "password" },
      { order: "sideways" },
      { search: "x".repeat(101) },
    ]) {
      expect(clientListQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("admin client responses", () => {
  const client = {
    id: uuid,
    name: "Lucia",
    phone: null,
    email: "lucia@example.com",
    notes: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    appointmentCount: 2,
    lastVisitAt: null,
  };

  test("parses a client row and the paged list", () => {
    expect(adminClientSchema.parse(client).appointmentCount).toBe(2);
    expect(
      listClientsResponseSchema.parse({ clients: [client], page: 1, pageSize: 20, total: 1 }).total,
    ).toBe(1);
    expect(adminClientSchema.safeParse({ ...client, appointmentCount: undefined }).success).toBe(
      false,
    );
  });

  test("the detail response carries the profile and the appointment history", () => {
    const parsed = clientDetailResponseSchema.parse({
      client,
      appointments: [
        {
          id: uuid2,
          staffId: uuid,
          clientId: uuid,
          startsAt: "2026-03-09T12:00:00.000Z",
          endsAt: "2026-03-09T13:00:00.000Z",
          status: "completed",
          notes: null,
          version: 2,
          services: [],
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      ],
    });
    expect(parsed.appointments[0]?.status).toBe("completed");
  });
});

describe("update client request", () => {
  test("accepts notes, phone and name, and null to clear phone and notes", () => {
    expect(updateClientRequestSchema.safeParse({ notes: "Allergic to ammonia" }).success).toBe(
      true,
    );
    expect(updateClientRequestSchema.safeParse({ phone: "+5491155550000" }).success).toBe(true);
    expect(updateClientRequestSchema.safeParse({ phone: null, notes: null }).success).toBe(true);
    expect(updateClientRequestSchema.safeParse({ name: "Lucia M." }).success).toBe(true);
  });

  test("needs a change and validates what it gets", () => {
    expect(updateClientRequestSchema.safeParse({}).success).toBe(false);
    expect(updateClientRequestSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(updateClientRequestSchema.safeParse({ phone: "1" }).success).toBe(false);
    expect(updateClientRequestSchema.safeParse({ name: null }).success).toBe(false);
  });

  test("does not let callers change identity fields", () => {
    const parsed = updateClientRequestSchema.parse({ name: "A", email: "x@y.io", userId: "u" });
    expect(parsed).toEqual({ name: "A" });
  });
});
