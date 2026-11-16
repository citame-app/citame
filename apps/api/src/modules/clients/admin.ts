import type {
  AdminClient,
  ClientDetailResponse,
  ClientListQuery,
  ListClientsResponse,
  UpdateClientRequest,
} from "@sob/contracts";
import { appointment, clientProfile, type Database } from "@sob/db";
import { and, asc, count, desc, eq, gt, ilike, isNull, max, ne, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { DomainError } from "../../errors";
import { listClientAppointments } from "../appointments/service";

export interface AdminActor {
  userId: string;
}

/** Visit statistics over non-cancelled appointments, joined onto the client rows. */
function visitStats(db: Pick<Database, "select">) {
  return db
    .select({
      clientId: appointment.clientId,
      visits: count().as("visits"),
      lastVisit: max(appointment.startsAt).as("last_visit"),
    })
    .from(appointment)
    .where(and(ne(appointment.status, "cancelled"), isNull(appointment.deletedAt)))
    .groupBy(appointment.clientId)
    .as("visit_stats");
}

/** Escapes LIKE wildcards so user input is always matched literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function searchFilter(term: string | undefined) {
  if (!term) return undefined;
  const like = `%${escapeLike(term)}%`;
  const digits = term.replace(/\D/g, "");
  return or(
    ilike(clientProfile.name, like),
    ilike(clientProfile.email, like),
    ilike(clientProfile.phone, like),
    sql`array_to_string(${clientProfile.tags}, ' ') ilike ${like}`,
    // "(11) 5555" must find "+54 9 11 5555-0000": compare digits only.
    digits.length >= 3
      ? sql`regexp_replace(${clientProfile.phone}, '[^0-9]', '', 'g') like ${`%${digits}%`}`
      : undefined,
  );
}

export async function listClients(
  db: Database,
  query: ClientListQuery,
): Promise<ListClientsResponse> {
  const stats = visitStats(db);
  const where = and(isNull(clientProfile.deletedAt), searchFilter(query.search));
  const direction = query.order === "desc" ? desc : asc;
  const byName = sql`lower(${clientProfile.name})`;

  const orderBy =
    query.sort === "name"
      ? [direction(byName), asc(clientProfile.id)]
      : query.sort === "createdAt"
        ? [direction(clientProfile.createdAt), asc(byName), asc(clientProfile.id)]
        : [
            sql`${stats.lastVisit} ${sql.raw(query.order === "desc" ? "desc" : "asc")} nulls last`,
            asc(byName),
            asc(clientProfile.id),
          ];

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: clientProfile.id,
        name: clientProfile.name,
        phone: clientProfile.phone,
        email: clientProfile.email,
        notes: clientProfile.notes,
        createdAt: clientProfile.createdAt,
        updatedAt: clientProfile.updatedAt,
        visits: stats.visits,
        lastVisit: stats.lastVisit,
      })
      .from(clientProfile)
      .leftJoin(stats, eq(stats.clientId, clientProfile.id))
      .where(where)
      .orderBy(...orderBy)
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize),
    db.select({ total: count() }).from(clientProfile).where(where),
  ]);

  return {
    page: query.page,
    pageSize: query.pageSize,
    total: totals[0]?.total ?? 0,
    clients: rows.map((row) => ({
      id: row.id,
      name: row.name,
      phone: row.phone,
      email: row.email,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      appointmentCount: Number(row.visits ?? 0),
      lastVisitAt: row.lastVisit ? new Date(row.lastVisit).toISOString() : null,
    })),
  };
}

export async function getAdminClient(
  db: Pick<Database, "select">,
  id: string,
): Promise<AdminClient> {
  const stats = visitStats(db);
  const [row] = await db
    .select({
      id: clientProfile.id,
      name: clientProfile.name,
      phone: clientProfile.phone,
      email: clientProfile.email,
      notes: clientProfile.notes,
      createdAt: clientProfile.createdAt,
      updatedAt: clientProfile.updatedAt,
      visits: stats.visits,
      lastVisit: stats.lastVisit,
    })
    .from(clientProfile)
    .leftJoin(stats, eq(stats.clientId, clientProfile.id))
    .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)));
  if (!row) throw new DomainError("not_found", `Client ${id} not found`);
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    appointmentCount: Number(row.visits ?? 0),
    lastVisitAt: row.lastVisit ? new Date(row.lastVisit).toISOString() : null,
  };
}

export async function getClientDetail(db: Database, id: string): Promise<ClientDetailResponse> {
  const client = await getAdminClient(db, id);
  return { client, appointments: await listClientAppointments(db, id) };
}

const EDITABLE = ["name", "phone", "notes"] as const;

/** Changes only what differs; the audit entry lists field names, never the values (notes are private). */
export async function updateClient(
  db: Database,
  id: string,
  input: UpdateClientRequest,
  actor: AdminActor,
): Promise<AdminClient> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(clientProfile)
      .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)));
    if (!current) throw new DomainError("not_found", `Client ${id} not found`);

    const changes: Partial<Pick<typeof clientProfile.$inferInsert, (typeof EDITABLE)[number]>> = {};
    if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
    if (input.phone !== undefined && input.phone !== current.phone) changes.phone = input.phone;
    if (input.notes !== undefined && input.notes !== current.notes) changes.notes = input.notes;
    const changed = Object.keys(changes).sort();
    if (changed.length > 0) {
      await tx.update(clientProfile).set(changes).where(eq(clientProfile.id, id));
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: "client.update",
        entity: "client",
        entityId: id,
        metadata: { changed },
      });
    }
    return getAdminClient(tx, id);
  });
}

/** Soft delete. Refused while the client still has upcoming, non-cancelled appointments. */
export async function deleteClient(
  db: Database,
  id: string,
  actor: AdminActor,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)));
    if (!current) throw new DomainError("not_found", `Client ${id} not found`);

    const [upcoming] = await tx
      .select({ id: appointment.id })
      .from(appointment)
      .where(
        and(
          eq(appointment.clientId, id),
          ne(appointment.status, "cancelled"),
          isNull(appointment.deletedAt),
          gt(appointment.endsAt, now),
        ),
      )
      .limit(1);
    if (upcoming) {
      throw new DomainError(
        "has_future_appointments",
        "This client has upcoming appointments; cancel them first",
      );
    }

    await tx.update(clientProfile).set({ deletedAt: now }).where(eq(clientProfile.id, id));
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: "client.delete",
      entity: "client",
      entityId: id,
    });
  });
}
