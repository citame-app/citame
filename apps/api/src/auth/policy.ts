import type {
  AppointmentListQuery,
  CreateAppointmentRequest,
  UpdateAppointmentRequest,
  UserRole,
} from "@sob/contracts";
import { DomainError } from "../errors";
import type { Principal } from "./principal";

/**
 * Authorization policy for appointments, as pure functions over a principal. They carry no
 * transport or database knowledge, so REST today and MCP tools in Phase 6 enforce the exact
 * same rules. Anything not explicitly allowed is forbidden.
 *
 *   owner   everything
 *   staff   appointments on their own calendar (read, create, reschedule, cancel)
 *   client  their own appointments only (create for themselves, read, reschedule, cancel)
 */

const forbidden = (message: string) => new DomainError("forbidden", message);

export function requireRole(principal: Principal, ...roles: UserRole[]): void {
  if (!roles.includes(principal.role)) {
    throw forbidden("You do not have permission to perform this action");
  }
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

export function authorizeAppointmentChange(
  principal: Principal,
  appointment: { staffId: string; clientId: string },
  request: UpdateAppointmentRequest,
): void {
  switch (principal.role) {
    case "owner":
      return;
    case "staff":
      if (!principal.staffId || appointment.staffId !== principal.staffId) {
        throw forbidden("This appointment is not on your calendar");
      }
      if (request.staffId !== undefined && request.staffId !== principal.staffId) {
        throw forbidden("Staff cannot move appointments to another calendar");
      }
      return;
    case "client":
      if (!principal.clientId || appointment.clientId !== principal.clientId) {
        throw forbidden("This is not your appointment");
      }
      return;
  }
}

/** Narrows a list query to what the principal may see. */
export function authorizeAppointmentList(
  principal: Principal,
  query: AppointmentListQuery,
): { query: AppointmentListQuery; clientId?: string } {
  switch (principal.role) {
    case "owner":
      return { query };
    case "staff":
      if (!principal.staffId) throw forbidden("Your account has no calendar");
      if (query.staffId !== undefined && query.staffId !== principal.staffId) {
        throw forbidden("Staff can only list their own calendar");
      }
      return { query: { ...query, staffId: principal.staffId } };
    case "client":
      if (!principal.clientId) throw forbidden("Your account has no booking profile");
      return { query, clientId: principal.clientId };
  }
}

/** Service catalog administration (create, edit, deactivate, assign performers). */
export function authorizeServiceAdmin(principal: Principal): void {
  requireRole(principal, "owner");
}

/** Staff profile administration and weekly hours replacement. */
export function authorizeStaffAdmin(principal: Principal): void {
  requireRole(principal, "owner");
}

/** Narrows the admin staff listing: the owner sees everyone, staff only themselves. */
export function authorizeStaffList(principal: Principal): { staffId?: string } {
  requireRole(principal, "owner", "staff");
  if (principal.role === "owner") return {};
  if (!principal.staffId) throw forbidden("Your account has no calendar");
  return { staffId: principal.staffId };
}

/** Owner: any staff member. Staff: only their own calendar. */
function requireOwnCalendarOrOwner(principal: Principal, staffId: string): void {
  requireRole(principal, "owner", "staff");
  if (principal.role === "staff" && (!principal.staffId || principal.staffId !== staffId)) {
    throw forbidden("This is not your calendar");
  }
}

/** Reading a staff member's working hours. */
export function authorizeStaffScheduleRead(principal: Principal, staffId: string): void {
  requireOwnCalendarOrOwner(principal, staffId);
}

/** Creating, editing or removing time off. */
export function authorizeTimeOffManage(principal: Principal, staffId: string): void {
  requireOwnCalendarOrOwner(principal, staffId);
}

/** Client directory: the front desk (owner and staff) sees every client. */
export function authorizeClientAccess(principal: Principal): void {
  requireRole(principal, "owner", "staff");
}

/** Only the owner removes (soft-deletes) clients. */
export function authorizeClientDelete(principal: Principal): void {
  requireRole(principal, "owner");
}
