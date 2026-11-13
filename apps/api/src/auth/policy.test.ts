import { describe, expect, test } from "bun:test";
import type { CreateAppointmentRequest } from "@sob/contracts";
import { DomainError } from "../errors";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeAppointmentList,
  authorizeServiceAdmin,
  requireRole,
} from "./policy";
import type { Principal } from "./principal";

const id = (n: number) => `0198f5a0-7b1c-7000-8000-${n.toString(16).padStart(12, "0")}`;

const owner: Principal = {
  userId: "owner",
  email: "o@x.io",
  name: "O",
  role: "owner",
  staffId: null,
  clientId: null,
};
const staffA: Principal = { ...owner, userId: "sa", role: "staff", staffId: id(0xa) };
const staffB: Principal = { ...owner, userId: "sb", role: "staff", staffId: id(0xb) };
const clientA: Principal = { ...owner, userId: "ca", role: "client", clientId: id(0xca) };

const booking = (over: Partial<CreateAppointmentRequest> = {}): CreateAppointmentRequest => ({
  staffId: id(0xa),
  serviceIds: [id(1)],
  startsAt: "2026-03-09T12:00:00.000Z",
  clientId: id(0xca),
  ...over,
});

function forbidden(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("forbidden");
    return;
  }
  throw new Error("expected a forbidden DomainError");
}

describe("requireRole", () => {
  test("passes for a listed role and is forbidden otherwise", () => {
    requireRole(owner, "owner");
    requireRole(staffA, "owner", "staff");
    forbidden(() => requireRole(staffA, "owner"));
    forbidden(() => requireRole(clientA, "owner", "staff"));
  });
});

describe("authorizeAppointmentCreate", () => {
  test("a client always books for themselves, whatever identity they claim", () => {
    const own = authorizeAppointmentCreate(clientA, booking());
    expect(own.clientId).toBe(id(0xca));

    const inline = authorizeAppointmentCreate(
      clientA,
      booking({ clientId: undefined, client: { name: "Someone Else" } }),
    );
    expect(inline.clientId).toBe(id(0xca));
    expect(inline.client).toBeUndefined();
  });

  test("a client cannot book on behalf of another client", () => {
    forbidden(() => authorizeAppointmentCreate(clientA, booking({ clientId: id(0xcb) })));
  });

  test("only staff and owners may use the min-notice override", () => {
    forbidden(() => authorizeAppointmentCreate(clientA, booking({ override: true })));
    expect(authorizeAppointmentCreate(clientA, booking({ override: false })).override).toBeFalsy();
    expect(authorizeAppointmentCreate(staffA, booking({ override: true })).override).toBe(true);
    expect(authorizeAppointmentCreate(owner, booking({ override: true })).override).toBe(true);
  });

  test("a client without a booking profile cannot book", () => {
    forbidden(() => authorizeAppointmentCreate({ ...clientA, clientId: null }, booking()));
  });

  test("staff book only into their own calendar, for any client", () => {
    expect(authorizeAppointmentCreate(staffA, booking({ clientId: id(0xcb) })).clientId).toBe(
      id(0xcb),
    );
    forbidden(() => authorizeAppointmentCreate(staffA, booking({ staffId: id(0xb) })));
    forbidden(() => authorizeAppointmentCreate({ ...staffA, staffId: null }, booking()));
  });

  test("the owner can book anything", () => {
    expect(authorizeAppointmentCreate(owner, booking({ staffId: id(0xb) }))).toMatchObject({
      staffId: id(0xb),
      clientId: id(0xca),
    });
  });
});

describe("authorizeAppointmentChange", () => {
  const appt = { staffId: id(0xa), clientId: id(0xca) };
  const cancel = { version: 1, status: "cancelled" as const };

  test("a client can change only their own appointment", () => {
    authorizeAppointmentChange(clientA, appt, cancel);
    authorizeAppointmentChange(clientA, appt, { version: 1, startsAt: "2026-03-09T15:00:00.000Z" });
    forbidden(() => authorizeAppointmentChange({ ...clientA, clientId: id(0xcb) }, appt, cancel));
  });

  test("staff manage appointments on their own calendar only", () => {
    authorizeAppointmentChange(staffA, appt, cancel);
    forbidden(() => authorizeAppointmentChange(staffB, appt, cancel));
  });

  test("staff cannot push an appointment into another staff calendar", () => {
    forbidden(() => authorizeAppointmentChange(staffA, appt, { version: 1, staffId: id(0xb) }));
    authorizeAppointmentChange(staffA, appt, { version: 1, staffId: id(0xa) });
  });

  test("the owner can change anything", () => {
    authorizeAppointmentChange(owner, appt, { version: 1, staffId: id(0xb) });
  });
});

describe("authorizeAppointmentList", () => {
  const range = { from: "2026-03-09T00:00:00Z", to: "2026-03-10T00:00:00Z" };

  test("clients are scoped to their own appointments", () => {
    expect(authorizeAppointmentList(clientA, range)).toEqual({ query: range, clientId: id(0xca) });
    forbidden(() => authorizeAppointmentList({ ...clientA, clientId: null }, range));
  });

  test("staff are scoped to their own calendar; asking for another is forbidden", () => {
    expect(authorizeAppointmentList(staffA, range)).toEqual({
      query: { ...range, staffId: id(0xa) },
    });
    authorizeAppointmentList(staffA, { ...range, staffId: id(0xa) });
    forbidden(() => authorizeAppointmentList(staffA, { ...range, staffId: id(0xb) }));
    forbidden(() => authorizeAppointmentList({ ...staffA, staffId: null }, range));
  });

  test("the owner sees everything, optionally filtered", () => {
    expect(authorizeAppointmentList(owner, range)).toEqual({ query: range });
    expect(authorizeAppointmentList(owner, { ...range, staffId: id(0xb) }).query.staffId).toBe(
      id(0xb),
    );
  });
});

describe("authorizeServiceAdmin", () => {
  test("only the owner administers the service catalog", () => {
    authorizeServiceAdmin(owner);
    forbidden(() => authorizeServiceAdmin(staffA));
    forbidden(() => authorizeServiceAdmin(clientA));
  });
});
