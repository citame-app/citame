import type { SyncMutation, SyncRejectReason, UpdateAppointmentRequest } from "@sob/contracts";
import {
  clientProfile,
  type Database,
  EXCLUSION_VIOLATION,
  pgErrorCode,
  salonSettings,
  service,
  staffProfile,
  timeOff,
} from "@sob/db";
import { and, eq, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeClientAccess,
  authorizeServiceAdmin,
  authorizeStaffAdmin,
  authorizeTimeOffManage,
  requireRole,
} from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockCalendars } from "../../tx";
import {
  createAppointment,
  getAppointmentOwnership,
  updateAppointment,
} from "../appointments/service";
import { updateClient } from "../clients/admin";
import { saveInventoryClassification } from "../inventory/classifications";
import { writePurchaseOrder } from "../inventory/orders";
import { saveProductPhoto } from "../inventory/photo";
import { receiveStockDocument, saveSupplier } from "../inventory/receipts";
import { createProduct, moveStock, updateProduct } from "../inventory/service";
import { saveWarehouse, transferStock } from "../inventory/warehouses";
import { createResource, setServiceResources, updateResource } from "../resources/catalog";
import {
  createService,
  setServiceStaff,
  updateService,
  updateServiceConfiguration,
} from "../services/admin";
import { saveCombination } from "../services/combinations";
import { getSalonSettings, updateReviewedSettings, updateSalonSettings } from "../settings/service";
import { requireStaff, updateStaff } from "../staff/admin";
import { createTimeOff, deleteTimeOff, updateTimeOff } from "../staff/schedule";

export interface ApplyContext {
  /** Clock for booking rules (injectable in tests). */
  now: () => Date;
  generation: string;
}

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

/** Maps a domain error to the reason code clients see; null means "not the caller's fault". */
export function rejectionReason(
  error: unknown,
): { reason: SyncRejectReason; message: string } | null {
  if (error instanceof DomainError) {
    const map: Partial<Record<DomainError["code"], SyncRejectReason>> = {
      validation_error: "invalid",
      unauthorized: "forbidden",
      forbidden: "forbidden",
      not_found: "not_found",
      slot_taken: "slot_taken",
      slot_unavailable: "slot_unavailable",
      version_conflict: "conflict",
      invalid_state: "invalid_state",
      promotion_timing_mismatch: "invalid_state",
      booking_promotion_changed: "invalid_state",
      client_merged: "conflict",
      intake_required: "intake_required",
      booking_intent_conflict: "booking_intent_conflict",
      has_future_appointments: "invalid_state",
      storage_limit: "invalid_state",
    };
    const reason = map[error.code];
    return reason ? { reason, message: error.message } : null;
  }
  switch (pgErrorCode(error)) {
    case EXCLUSION_VIOLATION:
      return { reason: "slot_taken", message: "The selected time slot is no longer available" };
    case UNIQUE_VIOLATION:
      return {
        reason: "invalid_state",
        message: "A row with this id or unique value already exists",
      };
    case FOREIGN_KEY_VIOLATION:
      return { reason: "invalid", message: "The mutation references a row that does not exist" };
    case CHECK_VIOLATION:
      return { reason: "invalid", message: "The mutation violates a data constraint" };
    default:
      return null;
  }
}

/**
 * The edit time used for last-writer-wins: the device's claim, clamped to the server clock so a
 * device with a clock in the future cannot win every later conflict.
 */
function editTime(createdAt: string): Date {
  return new Date(Math.min(Date.parse(createdAt), Date.now()));
}

/** Strictly newer edits win; a tie keeps the server's row (deterministic, replay safe). */
function assertNewer(current: Date, at: Date) {
  if (at.getTime() <= current.getTime()) {
    throw new DomainError(
      "version_conflict",
      "A newer change to this row already exists on the server",
    );
  }
}

const notFound = (what: string, id: string) =>
  new DomainError("not_found", `${what} ${id} not found`);

/**
 * Executes one mutation through the same service layer REST uses, so authorization, booking
 * rules, the calendar locks and the exclusion constraint all apply. Runs inside the caller's
 * transaction (service functions nest as savepoints). Throws on any rejection.
 */
export async function applyMutation(
  db: Database,
  principal: Principal,
  mutation: SyncMutation,
  ctx: ApplyContext,
): Promise<void> {
  const actor = { userId: principal.userId, role: principal.role };
  const now = ctx.now();
  const at = editTime(mutation.createdAt);

  switch (mutation.kind) {
    case "appointment.create": {
      const request = authorizeAppointmentCreate(principal, mutation.payload);
      await createAppointment(db, request, actor, { now });
      return;
    }
    case "appointment.reschedule":
    case "appointment.cancel":
    case "appointment.set_status": {
      const { id, ...rest } = mutation.payload;
      const body: UpdateAppointmentRequest =
        mutation.kind === "appointment.cancel"
          ? { version: mutation.payload.version, status: "cancelled" }
          : { ...rest };
      authorizeAppointmentChange(principal, await getAppointmentOwnership(db, id), body, now);
      await updateAppointment(db, id, body, actor, { now });
      return;
    }
    case "client.create": {
      authorizeClientAccess(principal);
      const p = mutation.payload;
      const [existing] = await db.select().from(clientProfile).where(eq(clientProfile.id, p.id));
      if (existing) {
        if (existing.deletedAt) throw new DomainError("invalid_state", "This client was deleted");
        assertNewer(existing.updatedAt, at);
        await updateClient(db, p.id, { name: p.name, phone: p.phone, notes: p.notes }, actor);
        await db.update(clientProfile).set({ updatedAt: at }).where(eq(clientProfile.id, p.id));
        return;
      }
      await db.insert(clientProfile).values({
        id: p.id,
        name: p.name,
        phone: p.phone,
        email: p.email,
        notes: p.notes,
        createdAt: at,
        updatedAt: at,
      });
      await recordAudit(db, {
        actorUserId: actor.userId,
        action: "client.create",
        entity: "client",
        entityId: p.id,
      });
      return;
    }
    case "client.update": {
      authorizeClientAccess(principal);
      const { id, expectedUpdatedAt, ...changes } = mutation.payload;
      const [current] = await db
        .select()
        .from(clientProfile)
        .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)));
      if (!current) throw notFound("Client", id);
      assertNewer(current.updatedAt, at);
      await updateClient(db, id, changes, actor, expectedUpdatedAt);
      await db.update(clientProfile).set({ updatedAt: at }).where(eq(clientProfile.id, id));
      return;
    }
    case "time_off.create": {
      const p = mutation.payload;
      authorizeTimeOffManage(principal, p.staffId);
      const created = await createTimeOff(
        db,
        p.staffId,
        { startsAt: p.startsAt, endsAt: p.endsAt, reason: p.reason },
        actor,
        now,
        { id: p.id },
      );
      await db.update(timeOff).set({ updatedAt: at }).where(eq(timeOff.id, created.timeOff.id));
      return;
    }
    case "time_off.update":
    case "time_off.delete": {
      const { id, staffId, expectedUpdatedAt, ...changes } = mutation.payload;
      authorizeTimeOffManage(principal, staffId);
      await lockCalendars(db, [staffId]);
      const [current] = await db
        .select()
        .from(timeOff)
        .where(and(eq(timeOff.id, id), eq(timeOff.staffId, staffId), isNull(timeOff.deletedAt)));
      if (!current) throw notFound("Time off", id);
      if (expectedUpdatedAt && Date.parse(expectedUpdatedAt) !== current.updatedAt.getTime()) {
        throw new DomainError(
          "version_conflict",
          "The time off changed since this device last reviewed it",
        );
      }
      assertNewer(current.updatedAt, at);
      if (mutation.kind === "time_off.delete") await deleteTimeOff(db, staffId, id, actor, now);
      else await updateTimeOff(db, staffId, id, changes, actor, now);
      await db.update(timeOff).set({ updatedAt: at }).where(eq(timeOff.id, id));
      return;
    }
    case "service.create": {
      authorizeServiceAdmin(principal);
      await createService(db, mutation.payload.service, actor, mutation.payload.id);
      return;
    }
    case "service.configure": {
      authorizeServiceAdmin(principal);
      const { id, assignment, ...configuration } = mutation.payload;
      await updateServiceConfiguration(db, id, { ...configuration, ...assignment }, actor);
      return;
    }
    case "service.update": {
      authorizeServiceAdmin(principal);
      const { id, ...changes } = mutation.payload;
      const [current] = await db
        .select()
        .from(service)
        .where(and(eq(service.id, id), isNull(service.deletedAt)));
      if (!current) throw notFound("Service", id);
      assertNewer(current.updatedAt, at);
      await updateService(db, id, changes, actor);
      await db.update(service).set({ updatedAt: at }).where(eq(service.id, id));
      return;
    }
    case "service.staff_replace": {
      authorizeServiceAdmin(principal);
      const { id, reviewedStaffIds, staffIds } = mutation.payload;
      await setServiceStaff(db, id, { staffIds }, actor, reviewedStaffIds);
      return;
    }
    case "service.resources": {
      const { id, ...input } = mutation.payload;
      await setServiceResources(db, id, input, principal, now);
      return;
    }
    case "resource.create": {
      const { id, ...input } = mutation.payload;
      await createResource(db, { ...input, idempotencyKey: mutation.mutationId }, principal, id);
      return;
    }
    case "resource.update": {
      const { id, ...input } = mutation.payload;
      await updateResource(db, id, input, principal, now);
      return;
    }
    case "combination.create": {
      const { id, ...input } = mutation.payload;
      await saveCombination(db, { ...input, idempotencyKey: mutation.mutationId }, principal, now, {
        kind: "create",
        id,
        reviewOnline: true,
      });
      return;
    }
    case "combination.update": {
      const { id, ...input } = mutation.payload;
      await saveCombination(db, input, principal, now, { kind: "update", id, reviewOnline: true });
      return;
    }
    case "product.create": {
      const { id, ...input } = mutation.payload;
      await createProduct(db, { ...input, idempotencyKey: mutation.mutationId }, principal, id);
      return;
    }
    case "product.update": {
      const { id, changes } = mutation.payload;
      await updateProduct(db, id, changes, principal);
      return;
    }
    case "product.photo": {
      const { id, ...photo } = mutation.payload;
      await saveProductPhoto(db, id, photo, principal);
      return;
    }
    case "supplier.save": {
      const { id, ...input } = mutation.payload;
      await saveSupplier(
        db,
        id,
        { ...input, generation: ctx.generation },
        principal,
        ctx.generation,
      );
      return;
    }
    case "purchase_order.write": {
      const { id, ...command } = mutation.payload;
      await writePurchaseOrder(
        db,
        id,
        { ...command, idempotencyKey: mutation.mutationId, generation: ctx.generation },
        principal,
        ctx.generation,
        now,
      );
      return;
    }
    case "stock.receipt": {
      const { id, ...input } = mutation.payload;
      await receiveStockDocument(
        db,
        { ...input, idempotencyKey: id, generation: ctx.generation },
        principal,
        ctx.generation,
        id,
      );
      return;
    }
    case "warehouse.save": {
      const { id, ...input } = mutation.payload;
      await saveWarehouse(
        db,
        id,
        { ...input, generation: ctx.generation },
        principal,
        ctx.generation,
      );
      return;
    }
    case "warehouse.transfer": {
      const { id, ...input } = mutation.payload;
      await transferStock(
        db,
        id,
        { ...input, generation: ctx.generation },
        principal,
        ctx.generation,
      );
      return;
    }
    case "warehouse.adjust": {
      const { id, productId, reviewedOnHand, ...input } = mutation.payload;
      await moveStock(
        db,
        productId,
        { ...input, generation: ctx.generation, idempotencyKey: id },
        principal,
        ctx.generation,
        { movementId: id, reviewedOnHand },
      );
      return;
    }
    case "inventory.classification_save": {
      const { id, ...input } = mutation.payload;
      await saveInventoryClassification(
        db,
        id,
        { ...input, generation: ctx.generation },
        principal,
        ctx.generation,
      );
      return;
    }
    case "staff.update": {
      authorizeStaffAdmin(principal);
      const { id, ...changes } = mutation.payload;
      const current = await requireStaff(db, id);
      assertNewer(current.updatedAt, at);
      await updateStaff(db, id, changes, actor, now);
      await db.update(staffProfile).set({ updatedAt: at }).where(eq(staffProfile.id, id));
      return;
    }
    case "settings.update": {
      requireRole(principal, "owner");
      if ("expectedRevision" in mutation.payload) {
        const { changes, expectedRevision } = mutation.payload;
        await updateReviewedSettings(db, changes, actor, expectedRevision);
        return;
      }
      const current = await getSalonSettings(db);
      assertNewer(current.updatedAt, at);
      await updateSalonSettings(db, mutation.payload, actor);
      await db.update(salonSettings).set({ updatedAt: at }).where(eq(salonSettings.id, 1));
      return;
    }
  }
}
