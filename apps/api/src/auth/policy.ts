import type {
  AppointmentListQuery,
  AppointmentStatus,
  CalendarQuery,
  CreateAppointmentRequest,
  ReportQuery,
  UpdateAppointmentRequest,
  UserRole,
} from "@sob/contracts";
import { permissionsFor, type StaffPermissions } from "@sob/contracts";
import { DomainError } from "../errors";
import { ownsClient, type Principal } from "./principal";

/**
 * Authorization policy for appointments, as pure functions over a principal. They carry no
 * transport or database knowledge, so REST today and MCP tools in Phase 6 enforce the exact
 * same rules. Anything not explicitly allowed is forbidden.
 *
 *   owner   everything
 *   staff   appointments on their own calendar (read, create, reschedule, cancel, mark
 *           completed / no_show)
 *   client  their own appointments only (create for themselves, read, reschedule, cancel)
 */

const forbidden = (message: string) => new DomainError("forbidden", message);

export function requireRole(principal: Pick<Principal, "role">, ...roles: UserRole[]): void {
  if (!roles.includes(principal.role)) {
    throw forbidden("You do not have permission to perform this action");
  }
}

export function requirePermission(principal: Principal, permission: keyof StaffPermissions): void {
  if (!permissionsFor(principal.role, principal.accessPreset)[permission])
    throw forbidden("Your access profile does not permit this operation");
}

export function canReviewVisitCheckouts(principal: Principal, staffIds: ReadonlyArray<string>) {
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  return (
    permissions.commerce &&
    ((permissions.allCalendars && permissions.allSales) ||
      staffIds.every((id) => id === principal.staffId))
  );
}

/**
 * Returns the request to execute. Clients are pinned to their own booking profile (an inline
 * `client` payload is dropped, so they cannot mint or impersonate profiles); staff are pinned
 * to their own calendar.
 */
export function authorizeAppointmentCreate(
  principal: Principal,
  request: CreateAppointmentRequest,
): CreateAppointmentRequest {
  switch (principal.role) {
    case "owner":
      return request;
    case "staff":
      requirePermission(principal, "editCalendar");
      if (permissionsFor(principal.role, principal.accessPreset).allCalendars) return request;
      if (!principal.staffId || request.staffId !== principal.staffId) {
        throw forbidden("Staff can only book into their own calendar");
      }
      return request;
    case "client": {
      if (!principal.clientId) throw forbidden("Your account has no booking profile");
      if (request.override) throw forbidden("Only staff can override the booking notice window");
      if (request.clientId && request.clientId !== principal.clientId) {
        throw forbidden("You can only book appointments for yourself");
      }
      const { client: _dropped, ...rest } = request;
      return { ...rest, clientId: principal.clientId };
    }
  }
}

/**
 * Who may change an existing appointment. A client acts only on their own appointment, and only
 * while it is `booked` and has not started: once it has started it may be about to become a
 * no-show (which a cancel would erase), and once it is closed it is the salon's record.
 */
export function authorizeAppointmentChange(
  principal: Principal,
  appointment: { staffId: string; clientId: string; status: AppointmentStatus; startsAt: Date },
  request: UpdateAppointmentRequest,
  now: Date = new Date(),
): void {
  const marking = request.status === "completed" || request.status === "no_show";
  switch (principal.role) {
    case "owner":
      return;
    case "staff":
      requirePermission(principal, "editCalendar");
      if (permissionsFor(principal.role, principal.accessPreset).allCalendars) return;
      if (!principal.staffId || appointment.staffId !== principal.staffId) {
        throw forbidden("This appointment is not on your calendar");
      }
      if (request.staffId !== undefined && request.staffId !== principal.staffId) {
        throw forbidden("Staff cannot move appointments to another calendar");
      }
      // Marking a finished appointment is front-desk work; fixing a mistake is the owner's.
      if (marking && appointment.status !== "booked") {
        throw forbidden("Only the owner can correct an appointment outcome");
      }
      return;
    case "client":
      if (!principal.clientId || !ownsClient(principal, appointment.clientId)) {
        throw forbidden("This is not your appointment");
      }
      if (marking) throw forbidden("Clients can only cancel their appointments");
      // A cancel attempt on a closed appointment passes through to the state machine, which
      // answers 409 `invalid_state` (cancelled is terminal, finished ones are not cancellable).
      if (appointment.status !== "booked" && request.status !== "cancelled") {
        throw forbidden("Only a booked appointment can be changed");
      }
      if (appointment.startsAt.getTime() <= now.getTime()) {
        throw forbidden("This appointment has already started");
      }
      if (request.override) {
        throw forbidden("Only staff can override the booking notice window");
      }
      return;
  }
}

/** Narrows a list query to what the principal may see. */
export function authorizeAppointmentList(
  principal: Principal,
  query: AppointmentListQuery,
): { query: AppointmentListQuery; clientId?: string; clientIds?: string[] } {
  switch (principal.role) {
    case "owner":
      return { query };
    case "staff":
      if (permissionsFor(principal.role, principal.accessPreset).allCalendars) return { query };
      if (!principal.staffId) throw forbidden("Your account has no calendar");
      if (query.staffId !== undefined && query.staffId !== principal.staffId) {
        throw forbidden("Staff can only list their own calendar");
      }
      return { query: { ...query, staffId: principal.staffId } };
    case "client":
      if (!principal.clientId) throw forbidden("Your account has no booking profile");
      return {
        query,
        clientId: principal.clientId,
        ...(principal.clientIds ? { clientIds: principal.clientIds } : {}),
      };
  }
}

/** Service catalog administration (create, edit, deactivate, assign performers). */
export function authorizeServiceAdmin(principal: Principal): void {
  requirePermission(principal, "editCatalog");
}

/** Staff profile administration and weekly hours replacement. */
export function authorizeStaffAdmin(principal: Principal): void {
  requirePermission(principal, "editSchedules");
}

/** Narrows the admin staff listing: the owner sees everyone, staff only themselves. */
export function authorizeStaffList(principal: Principal): { staffId?: string } {
  requireRole(principal, "owner", "staff");
  if (permissionsFor(principal.role, principal.accessPreset).allCalendars) return {};
  if (!principal.staffId) throw forbidden("Your account has no calendar");
  return { staffId: principal.staffId };
}

/** Owner: any staff member. Staff: only their own calendar. */
function requireOwnCalendarOrOwner(principal: Principal, staffId: string): void {
  requireRole(principal, "owner", "staff");
  if (
    principal.role === "staff" &&
    !permissionsFor(principal.role, principal.accessPreset).allCalendars &&
    (!principal.staffId || principal.staffId !== staffId)
  ) {
    throw forbidden("This is not your calendar");
  }
}

/** Reading a staff member's working hours. */
export function authorizeStaffScheduleRead(principal: Principal, staffId: string): void {
  requireOwnCalendarOrOwner(principal, staffId);
}

/** Creating, editing or removing time off. */
export function authorizeTimeOffManage(principal: Principal, staffId: string): void {
  requirePermission(principal, "editCalendar");
  if (
    !permissionsFor(principal.role, principal.accessPreset).editSchedules &&
    principal.staffId !== staffId
  )
    throw forbidden("You can only manage your own time off");
  requireOwnCalendarOrOwner(principal, staffId);
}

/** Client directory: the front desk (owner and staff) sees every client. */
export function authorizeClientAccess(principal: Principal): void {
  requirePermission(principal, "clients");
}

/** Only the owner removes (soft-deletes) clients. */
export function authorizeClientDelete(principal: Principal): void {
  requirePermission(principal, "deleteClients");
}

/**
 * Reports: the owner sees the whole salon (optionally one staff member); staff get only their
 * own numbers (the query is pinned to their calendar); clients get none.
 */
export function authorizeReportQuery(principal: Principal, query: ReportQuery): ReportQuery {
  requirePermission(principal, "operationalReports");
  if (permissionsFor(principal.role, principal.accessPreset).allCalendars) return query;
  if (!principal.staffId) throw forbidden("Your account has no calendar");
  if (query.staffId !== undefined && query.staffId !== principal.staffId) {
    throw forbidden("Staff can only see their own reports");
  }
  return { ...query, staffId: principal.staffId };
}

/**
 * Calendar read model: the owner sees any staff (or all of them); staff only their own
 * calendar; clients never (the response names other clients).
 */
export function authorizeCalendarQuery(
  principal: Principal,
  query: Partial<CalendarQuery>,
): { staffIds?: string[]; includeBilling: boolean; visitCheckoutScope?: string } {
  requireRole(principal, "owner", "staff");
  const { allCalendars, allSales, commerce } = permissionsFor(
    principal.role,
    principal.accessPreset,
  );
  if (query.resourceOccupancy && !allCalendars)
    throw forbidden("Resource occupancy requires access to all calendars");
  const visitCheckoutScope = commerce
    ? allCalendars && allSales
      ? "all"
      : (principal.staffId ?? undefined)
    : undefined;
  if (allCalendars)
    return { staffIds: query.staffIds, includeBilling: commerce, visitCheckoutScope };
  if (!principal.staffId) throw forbidden("Your account has no calendar");
  if (query.staffIds?.some((staffId) => staffId !== principal.staffId)) {
    throw forbidden("Staff can only see their own calendar");
  }
  return { staffIds: [principal.staffId], includeBilling: commerce, visitCheckoutScope };
}
