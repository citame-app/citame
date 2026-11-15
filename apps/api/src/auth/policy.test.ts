import { describe, expect, test } from "bun:test";
import type { CreateAppointmentRequest } from "@sob/contracts";
import { DomainError } from "../errors";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeAppointmentList,
  authorizeCalendarQuery,
  authorizeClientAccess,
  authorizeClientDelete,
  authorizeReportQuery,
  authorizeServiceAdmin,
  authorizeStaffAdmin,
  authorizeStaffList,
  authorizeStaffScheduleRead,
  authorizeTimeOffManage,
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
  const now = new Date("2026-03-02T12:00:00Z");
  const appt = {
    staffId: id(0xa),
    clientId: id(0xca),
    status: "booked" as const,
    startsAt: new Date("2026-03-09T12:00:00Z"),
  };
  const cancel = { version: 1, status: "cancelled" as const };

  test("a client can change only their own appointment", () => {
    authorizeAppointmentChange(clientA, appt, cancel, now);
    authorizeAppointmentChange(
      clientA,
      appt,
      { version: 1, startsAt: "2026-03-09T15:00:00.000Z" },
      now,
    );
    forbidden(() =>
      authorizeAppointmentChange({ ...clientA, clientId: id(0xcb) }, appt, cancel, now),
    );
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

  test("clients may only cancel: completed and no_show are for the salon", () => {
    authorizeAppointmentChange(clientA, appt, { version: 1, status: "cancelled" }, now);
    forbidden(() =>
      authorizeAppointmentChange(clientA, appt, { version: 1, status: "completed" }, now),
    );
    forbidden(() =>
      authorizeAppointmentChange(clientA, appt, { version: 1, status: "no_show" }, now),
    );
  });

  test("staff mark completed and no_show only on their own calendar; the owner anywhere", () => {
    for (const status of ["completed", "no_show"] as const) {
      authorizeAppointmentChange(staffA, appt, { version: 1, status });
      forbidden(() => authorizeAppointmentChange(staffB, appt, { version: 1, status }));
      authorizeAppointmentChange(owner, appt, { version: 1, status });
    }
  });

  test("correcting completed <-> no_show is owner-only, even on your own calendar", () => {
    const done = { ...appt, status: "completed" as const };
    const missed = { ...appt, status: "no_show" as const };
    authorizeAppointmentChange(owner, done, { version: 2, status: "no_show" });
    authorizeAppointmentChange(owner, missed, { version: 2, status: "completed" });
    forbidden(() => authorizeAppointmentChange(staffA, done, { version: 2, status: "no_show" }));
    forbidden(() =>
      authorizeAppointmentChange(staffA, missed, { version: 2, status: "completed" }),
    );
  });

  // Decision (ADR 0004): a client changes an appointment (cancel, move, notes) only while it is
  // booked and has not started. After that the record belongs to the salon: it may already be
  // closed, and a started booking may be about to become a no-show, which a cancel would erase.
  test("clients cannot edit notes or move an appointment that is no longer booked", () => {
    for (const status of ["completed", "no_show", "cancelled"] as const) {
      const closed = { ...appt, status };
      forbidden(() => authorizeAppointmentChange(clientA, closed, { version: 2, notes: "x" }, now));
      forbidden(() =>
        authorizeAppointmentChange(
          clientA,
          closed,
          { version: 2, startsAt: "2026-03-10T12:00:00.000Z" },
          now,
        ),
      );
      // A cancel attempt is left to the state machine, which answers 409 invalid_state.
      authorizeAppointmentChange(clientA, closed, cancel, now);
    }
  });

  test("clients cannot cancel, move or annotate once the appointment has started", () => {
    const started = { ...appt, startsAt: new Date("2026-03-02T11:00:00Z") };
    forbidden(() => authorizeAppointmentChange(clientA, started, cancel, now));
    forbidden(() =>
      authorizeAppointmentChange(
        clientA,
        started,
        { version: 1, startsAt: "2026-03-09T15:00:00.000Z" },
        now,
      ),
    );
    forbidden(() => authorizeAppointmentChange(clientA, started, { version: 1, notes: "x" }, now));
    // Exactly at the start counts as started.
    forbidden(() => authorizeAppointmentChange(clientA, { ...appt, startsAt: now }, cancel, now));
    // Before the start the same changes are fine.
    authorizeAppointmentChange(clientA, appt, cancel, now);
    authorizeAppointmentChange(clientA, appt, { version: 1, notes: "x" }, now);
  });

  test("the salon can still close or correct a started or closed appointment", () => {
    const started = { ...appt, startsAt: new Date("2026-03-02T11:00:00Z") };
    authorizeAppointmentChange(staffA, started, { version: 1, status: "no_show" }, now);
    authorizeAppointmentChange(
      owner,
      { ...started, status: "completed" },
      { version: 2, status: "no_show" },
      now,
    );
  });

  test("the min-notice override on a move is for staff and owners only", () => {
    const move = { version: 1, startsAt: "2026-03-09T15:00:00.000Z", override: true };
    authorizeAppointmentChange(staffA, appt, move);
    authorizeAppointmentChange(owner, appt, move);
    forbidden(() => authorizeAppointmentChange(clientA, appt, move));
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

describe("staff administration policy", () => {
  test("only the owner edits staff profiles and weekly hours", () => {
    authorizeStaffAdmin(owner);
    forbidden(() => authorizeStaffAdmin(staffA));
    forbidden(() => authorizeStaffAdmin(clientA));
  });

  test("the admin staff list is the whole team for the owner and just yourself for staff", () => {
    expect(authorizeStaffList(owner)).toEqual({});
    expect(authorizeStaffList(staffA)).toEqual({ staffId: id(0xa) });
    forbidden(() => authorizeStaffList({ ...staffA, staffId: null }));
    forbidden(() => authorizeStaffList(clientA));
  });

  test("working hours: the owner reads anyone, staff only their own, clients nobody", () => {
    authorizeStaffScheduleRead(owner, id(0xb));
    authorizeStaffScheduleRead(staffA, id(0xa));
    forbidden(() => authorizeStaffScheduleRead(staffA, id(0xb)));
    forbidden(() => authorizeStaffScheduleRead({ ...staffA, staffId: null }, id(0xa)));
    forbidden(() => authorizeStaffScheduleRead(clientA, id(0xa)));
  });

  test("time off: the owner manages anyone, staff only their own entries, clients nobody", () => {
    authorizeTimeOffManage(owner, id(0xb));
    authorizeTimeOffManage(staffA, id(0xa));
    forbidden(() => authorizeTimeOffManage(staffA, id(0xb)));
    forbidden(() => authorizeTimeOffManage(clientA, id(0xa)));
  });
});

describe("client directory policy", () => {
  test("owner and staff read and edit every client; clients none", () => {
    authorizeClientAccess(owner);
    authorizeClientAccess(staffA);
    forbidden(() => authorizeClientAccess(clientA));
  });

  test("only the owner deletes clients", () => {
    authorizeClientDelete(owner);
    forbidden(() => authorizeClientDelete(staffA));
    forbidden(() => authorizeClientDelete(clientA));
  });
});

describe("authorizeReportQuery", () => {
  const range = { from: "2026-03-09", to: "2026-03-11" };

  test("the owner sees everything, optionally filtered to one staff member", () => {
    expect(authorizeReportQuery(owner, range)).toEqual(range);
    expect(authorizeReportQuery(owner, { ...range, staffId: id(0xb) }).staffId).toBe(id(0xb));
  });

  test("staff are pinned to their own numbers; asking for someone else is forbidden", () => {
    expect(authorizeReportQuery(staffA, range)).toEqual({ ...range, staffId: id(0xa) });
    authorizeReportQuery(staffA, { ...range, staffId: id(0xa) });
    forbidden(() => authorizeReportQuery(staffA, { ...range, staffId: id(0xb) }));
    forbidden(() => authorizeReportQuery({ ...staffA, staffId: null }, range));
  });

  test("clients get no reports", () => {
    forbidden(() => authorizeReportQuery(clientA, range));
  });
});

describe("authorizeCalendarQuery", () => {
  const range = { from: "2026-03-09T00:00:00Z", to: "2026-03-16T00:00:00Z" };

  test("the owner sees everyone or any chosen staff members", () => {
    expect(authorizeCalendarQuery(owner, range)).toEqual({});
    expect(authorizeCalendarQuery(owner, { ...range, staffIds: [id(0xa), id(0xb)] })).toEqual({
      staffIds: [id(0xa), id(0xb)],
    });
  });

  test("staff are pinned to their own calendar; naming anyone else is forbidden", () => {
    expect(authorizeCalendarQuery(staffA, range)).toEqual({ staffIds: [id(0xa)] });
    expect(authorizeCalendarQuery(staffA, { ...range, staffIds: [id(0xa)] })).toEqual({
      staffIds: [id(0xa)],
    });
    forbidden(() => authorizeCalendarQuery(staffA, { ...range, staffIds: [id(0xa), id(0xb)] }));
    forbidden(() => authorizeCalendarQuery(staffA, { ...range, staffIds: [id(0xb)] }));
    forbidden(() => authorizeCalendarQuery({ ...staffA, staffId: null }, range));
  });

  test("clients never get the calendar", () => {
    forbidden(() => authorizeCalendarQuery(clientA, range));
  });
});
