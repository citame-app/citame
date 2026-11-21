import type { SyncChange, SyncEntity, SyncPullQuery, SyncPullResponse } from "@sob/contracts";
import { permissionsFor, type SyncLiveView, syncLiveViewSchema } from "@sob/contracts";
import {
  appointment,
  clientProfile,
  type Database,
  dateShift,
  salonSettings,
  service,
  serviceStaff,
  staffProfile,
  syncChange,
  timeOff,
  workingHours,
} from "@sob/db";
import {
  and,
  asc,
  eq,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
} from "drizzle-orm";
import type { Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { calendarBadges } from "../appointments/context";
import { loadSnapshots, toAppointment } from "../appointments/service";
import { groupName } from "../clients/groups";
import { compatibleBillingReasons } from "../commerce/appointment-billing";
import { listResources } from "../resources/catalog";
import { listCombinations } from "../services/combinations";
import { catalogMetadata, publicService } from "../services/options";
import { toReviewedSettings, toSalonResponse } from "../settings/service";

/**
 * Highest committed `seq`. Because seq order equals commit order (ADR 0007), everything at or
 * below it that will ever be visible is already visible, so it is always a safe cursor.
 */
export async function headSeq(db: Pick<Database, "select">): Promise<number> {
  const [row] = await db.select({ head: max(syncChange.seq) }).from(syncChange);
  return Number(row?.head ?? 0);
}

interface Entry {
  entity: SyncEntity;
  id: string;
  op: "upsert";
  data: unknown;
}
type Visible = Map<string, Entry>;

const hhmm = (time: string) => time.slice(0, 5);

/**
 * Current state of the rows an entity's changes point at, as the caller may see them. A row
 * that is missing, soft-deleted or not visible to the caller is simply absent from the map and
 * is announced as a tombstone.
 */
async function loadVisible(
  db: Database,
  principal: Principal,
  entity: SyncEntity,
  ids: string[],
  projection: Pick<SyncPullQuery, "booksyPaymentReview" | "clientGroups">,
): Promise<Visible> {
  const out: Visible = new Map();
  const put = (id: string, data: unknown) => out.set(id, { entity, id, op: "upsert", data });
  const owner = principal.role === "owner";
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  const ownCalendar = (staffId: string) =>
    permissions.allCalendars || staffId === principal.staffId;

  switch (entity) {
    case "appointment": {
      const rows = await db
        .select({ row: appointment, clientName: clientProfile.name })
        .from(appointment)
        .innerJoin(clientProfile, eq(clientProfile.id, appointment.clientId))
        .where(and(inArray(appointment.id, ids), isNull(appointment.deletedAt)));
      const visible = rows.filter(({ row }) => ownCalendar(row.staffId));
      const snapshots = await loadSnapshots(
        db,
        visible.map(({ row }) => row.id),
      );
      const badges = await calendarBadges(
        db,
        visible.map(({ row }) => row),
        [...snapshots.values()].flat(),
        { includeBilling: permissions.commerce },
      );
      for (const { row, clientName } of visible) {
        const billing = badges.get(row.id);
        put(row.id, {
          ...toAppointment(row, snapshots.get(row.id) ?? []),
          clientName,
          ...(billing?.badges.some(
            (badge) =>
              badge.requested ||
              badge.invoiced ||
              badge.paid ||
              badge.internalNote ||
              badge.customerComment,
          )
            ? { serviceBadges: billing.badges }
            : {}),
          ...(billing?.reasons.length
            ? {
                billingReviewReasons: compatibleBillingReasons(
                  billing.reasons,
                  projection.booksyPaymentReview === "1",
                ),
              }
            : {}),
          ...(billing?.externallySettled ? { externallySettled: true as const } : {}),
          ...(billing?.externalBalance ? { externalBalance: billing.externalBalance } : {}),
          ...(billing?.importedFromBooksy ? { importedFromBooksy: true as const } : {}),
          ...(billing?.booksyUnpaidConfirmed ? { booksyUnpaidConfirmed: true as const } : {}),
        });
      }
      break;
    }
    case "client": {
      if (!permissions.clients) break;
      const groupNames = projection.clientGroups
        ? sql<
            string[] | null
          >`array(select distinct ${groupName} from unnest(${clientProfile.tags}) as client_tag(name)
          where ${groupName} <> '' order by 1)`
        : sql<string[] | null>`null`;
      const rows = await db
        .select({ ...getTableColumns(clientProfile), groupNames })
        .from(clientProfile)
        .where(and(inArray(clientProfile.id, ids), isNull(clientProfile.deletedAt)));
      for (const r of rows) {
        put(r.id, {
          id: r.id,
          ...(r.mergedIntoId ? { mergedIntoId: r.mergedIntoId } : {}),
          name: r.name,
          phone: r.phone,
          email: r.email,
          notes: r.notes,
          controlsVersion: r.controlsVersion,
          ...(r.groupNames ? { groupNames: r.groupNames } : {}),
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      break;
    }
    case "service": {
      const rows = await db
        .select()
        .from(service)
        .where(and(inArray(service.id, ids), isNull(service.deletedAt)));
      const catalog = await catalogMetadata(db, rows);
      for (const r of rows) {
        put(r.id, {
          ...publicService(r, catalog.get(r.id)),
          version: r.catalogVersion,
          active: r.active,
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      break;
    }
    case "staff": {
      const rows = await db
        .select()
        .from(staffProfile)
        .where(and(inArray(staffProfile.id, ids), isNull(staffProfile.deletedAt)));
      for (const r of rows) {
        put(r.id, {
          id: r.id,
          displayName: r.displayName,
          active: r.active,
          ...(r.maxConcurrent !== 1 ? { maxConcurrent: r.maxConcurrent } : {}),
          // The login link is account administration: owner only.
          userId: owner ? r.userId : null,
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      break;
    }
    case "service_staff": {
      const rows = await db
        .select()
        .from(serviceStaff)
        .where(and(inArray(serviceStaff.id, ids), isNull(serviceStaff.deletedAt)));
      for (const r of rows) put(r.id, { id: r.id, serviceId: r.serviceId, staffId: r.staffId });
      break;
    }
    case "working_hours": {
      const rows = await db
        .select()
        .from(workingHours)
        .where(and(inArray(workingHours.id, ids), isNull(workingHours.deletedAt)));
      for (const r of rows.filter((row) => ownCalendar(row.staffId))) {
        put(r.id, {
          id: r.id,
          staffId: r.staffId,
          weekday: r.weekday,
          startTime: hhmm(r.startTime),
          endTime: hhmm(r.endTime),
        });
      }
      break;
    }
    case "date_shift": {
      const rows = await db.select().from(dateShift).where(inArray(dateShift.id, ids));
      for (const row of rows.filter((row) => ownCalendar(row.staffId)))
        put(row.id, {
          id: row.id,
          staffId: row.staffId,
          date: row.date,
          ranges: row.ranges,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
        });
      break;
    }
    case "time_off": {
      const rows = await db
        .select()
        .from(timeOff)
        .where(and(inArray(timeOff.id, ids), isNull(timeOff.deletedAt)));
      for (const r of rows.filter((row) => ownCalendar(row.staffId))) {
        put(r.id, {
          id: r.id,
          staffId: r.staffId,
          startsAt: r.startsAt.toISOString(),
          endsAt: r.endsAt.toISOString(),
          reason: r.reason,
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      break;
    }
    case "salon_settings": {
      const rows = await db.select().from(salonSettings);
      for (const r of rows) {
        put(String(r.id), {
          ...toSalonResponse(r),
          ownerConfiguration: owner ? toReviewedSettings(r) : null,
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      break;
    }
  }
  return out;
}

/**
 * One page of the change log after `since`. `limit` bounds the log rows scanned; entries for
 * the same row inside the page collapse into the latest one, and each entry carries the row's
 * CURRENT state (never a stale snapshot), or a tombstone when the row is gone or hidden from
 * the caller. The cursor advances over everything scanned, including entries the caller may not
 * see, so filtered pages never stall.
 */
export async function pullChanges(
  db: Database,
  principal: Principal,
  query: SyncPullQuery,
): Promise<SyncPullResponse> {
  if (principal.role === "client") {
    throw new DomainError("forbidden", "Sync is available to staff and owners only");
  }
  const head = await headSeq(db);
  if (query.since > head) {
    throw new DomainError(
      "invalid_state",
      "The cursor is ahead of the server; discard local state and resync from 0",
    );
  }

  const scanned = await db
    .select()
    .from(syncChange)
    .where(gt(syncChange.seq, query.since))
    .orderBy(asc(syncChange.seq))
    .limit(query.limit + 1);
  const hasMore = scanned.length > query.limit;
  const page = scanned.slice(0, query.limit);
  const nextCursor = page.at(-1)?.seq ?? query.since;

  // Latest entry per row wins; Map keeps first-insertion order, so delete before set to order
  // the survivors by the seq of their last occurrence.
  const latest = new Map<string, (typeof page)[number]>();
  const refresh = new Set<SyncLiveView>();
  const permissions = permissionsFor(principal.role, principal.accessPreset);
  for (const row of page) {
    if (row.entity === "live_view") {
      const topic = syncLiveViewSchema.safeParse(row.rowId);
      if (
        topic.success &&
        (topic.data !== "commerce" || permissions.commerce || permissions.manageCash) &&
        (topic.data !== "portfolio" || (query.portfolio === "1" && permissions.editCatalog)) &&
        (topic.data !== "review_requests" ||
          (query.reviewRequests === "1" && permissions.editCatalog)) &&
        (topic.data !== "intake_forms" ||
          (query.intakeViews === "1" && permissions.deleteClients)) &&
        (topic.data !== "intake_records" || (query.intakeViews === "1" && permissions.clients)) &&
        (topic.data !== "booking_policy" || query.bookingPolicy === "1") &&
        (topic.data !== "email_delivery" ||
          (query.emailDelivery === "1" && principal.role === "owner")) &&
        (topic.data !== "whatsapp_desk" ||
          (query.whatsappDesk === "1" && principal.role === "owner")) &&
        (topic.data !== "whatsapp_settings" ||
          (query.whatsappSettings === "1" && principal.role === "owner")) &&
        (topic.data !== "resource_catalogue" ||
          (query.resourceCatalogue === "1" && permissions.editCatalog)) &&
        (topic.data !== "service_combinations" ||
          (query.combinationCatalogue === "1" && permissions.editCatalog))
      )
        refresh.add(topic.data);
      continue;
    }
    const key = `${row.entity}\u0000${row.rowId}`;
    latest.delete(key);
    latest.set(key, row);
  }

  const idsByEntity = new Map<SyncEntity, string[]>();
  for (const row of latest.values()) {
    const entity = row.entity as SyncEntity;
    idsByEntity.set(entity, [...(idsByEntity.get(entity) ?? []), row.rowId]);
  }
  const states = new Map<SyncEntity, Visible>();
  for (const [entity, ids] of idsByEntity) {
    states.set(entity, await loadVisible(db, principal, entity, ids, query));
  }

  const changes: SyncChange[] = [];
  for (const row of latest.values()) {
    const entity = row.entity as SyncEntity;
    const state = states.get(entity)?.get(row.rowId);
    changes.push(
      state
        ? ({ ...state, seq: row.seq } as SyncChange)
        : { seq: row.seq, entity, id: row.rowId, op: "delete", data: null },
    );
  }
  const timeOffScope = !permissions.editCalendar
    ? "none"
    : permissions.editSchedules && permissions.allCalendars
      ? "all"
      : (principal.staffId ?? "none");
  const catalogColors =
    query.catalogColors === "1"
      ? Object.fromEntries(
          (
            await db
              .select({ id: service.id, color: service.color })
              .from(service)
              .where(and(isNull(service.deletedAt), isNotNull(service.color)))
          ).flatMap(({ id, color }) => (color === null ? [] : [[id, color] as const])),
        )
      : undefined;
  const resourceChanged = page.some(
    (row) => row.entity === "live_view" && row.rowId === "resource_catalogue",
  );
  const resourcePools =
    permissions.editCatalog &&
    (query.resourcePools === "full" || (query.resourcePools === "delta" && resourceChanged))
      ? (await listResources(db, principal)).resources
      : undefined;
  const combinationsChanged = page.some(
    (row) =>
      (row.entity === "live_view" && row.rowId === "service_combinations") ||
      row.entity === "service" ||
      row.entity === "service_staff" ||
      row.entity === "staff",
  );
  const combinations =
    permissions.editCatalog &&
    (query.combinations === "full" || (query.combinations === "delta" && combinationsChanged))
      ? (await listCombinations(db, principal)).combinations
      : undefined;
  return {
    changes,
    ...(catalogColors ? { catalogColors } : {}),
    ...(resourcePools ? { resourcePools } : {}),
    ...(combinations ? { combinations } : {}),
    ...(refresh.size ? { refresh: [...refresh] } : {}),
    nextCursor,
    hasMore,
    headSeq: Math.max(head, nextCursor),
    timeOffScope,
    clientDirectory: permissions.clients,
    ...(query.clientGroups && permissions.clients ? { clientGroups: true as const } : {}),
    viewerRole: principal.role === "owner" ? "owner" : "staff",
    viewerEditCatalogue: permissions.editCatalog,
    ...(query.portfolio === "1" ? { portfolioUploads: permissions.editCatalog } : {}),
    ...(query.inventoryAccess === "1"
      ? {
          viewerWriteInventory: permissions.writeInventory,
          viewerReadInventory: permissions.readInventory,
        }
      : {}),
    calendarScope: permissions.allCalendars ? "all" : (principal.staffId ?? "none"),
  };
}
