import { createHash } from "node:crypto";
import type {
  AdminClient,
  ClientDetailResponse,
  ClientListQuery,
  CreateClientRequest,
  ListClientsResponse,
  UpdateClientRequest,
} from "@sob/contracts";
import { appointment, auditLog, clientProfile, type Database } from "@sob/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  max,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot, requireClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import { listClientAppointments } from "../appointments/service";
import { groupName } from "./groups";

export interface AdminActor {
  userId: string;
}

/** Visit statistics over non-cancelled appointments, joined onto the client rows. */
function visitStats(db: Pick<Database, "select">) {
  const individual = db
    .select({
      clientId: appointment.clientId,
      visits: count().as("visits"),
      lastVisit: max(appointment.startsAt).as("last_visit"),
    })
    .from(appointment)
    .where(and(ne(appointment.status, "cancelled"), isNull(appointment.deletedAt)))
    .groupBy(appointment.clientId)
    .as("individual_visits");
  const root = sql<string>`client_root_id(${individual.clientId})`;
  return db
    .select({
      clientId: root.as("client_id"),
      visits: sql<number>`sum(${individual.visits})`.mapWith(Number).as("visits"),
      lastVisit: max(individual.lastVisit).as("last_visit"),
    })
    .from(individual)
    .groupBy(root)
    .as("visit_stats");
}

/** Escapes LIKE wildcards so user input is always matched literally. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export function searchFilter(term: string | undefined) {
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
    sql`exists(select 1 from client_profile historical where historical.id in(select client_identity_ids(${clientProfile.id})) and historical.id<>${clientProfile.id} and (
      historical.name ilike ${like} or historical.email ilike ${like} or historical.phone ilike ${like}
      ${digits.length >= 3 ? sql`or regexp_replace(historical.phone,'[^0-9]','','g') like ${`%${digits}%`}` : sql``}
    ))`,
  );
}

export async function listClients(
  db: Database,
  query: ClientListQuery,
): Promise<ListClientsResponse> {
  const stats = visitStats(db);
  const where = and(
    isNull(clientProfile.deletedAt),
    isNull(clientProfile.mergedIntoId),
    searchFilter(query.search),
    query.tag
      ? sql`exists (select 1 from unnest(${clientProfile.tags}) as client_tag(name)
          where ${groupName} = ${query.tag})`
      : undefined,
  );
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
        tags: clientProfile.tags,
        contactDetails: clientProfile.contactDetails,
        detailsVersion: clientProfile.detailsVersion,
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
      tags: row.tags,
      contactDetails: row.contactDetails,
      detailsVersion: row.detailsVersion,
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
      tags: clientProfile.tags,
      contactDetails: clientProfile.contactDetails,
      detailsVersion: clientProfile.detailsVersion,
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
    tags: row.tags,
    contactDetails: row.contactDetails,
    detailsVersion: row.detailsVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    appointmentCount: Number(row.visits ?? 0),
    lastVisitAt: row.lastVisit ? new Date(row.lastVisit).toISOString() : null,
  };
}

export async function getClientDetail(db: Database, id: string): Promise<ClientDetailResponse> {
  return db.transaction(
    async (tx) => {
      const root = await clientRoot(tx, id);
      const client = await getAdminClient(tx, id);
      const identities = await clientIdentityIds(tx, id);
      const profiles =
        identities.length > 1
          ? await tx
              .select({
                id: clientProfile.id,
                name: clientProfile.name,
                email: clientProfile.email,
                phone: clientProfile.phone,
                notes: clientProfile.notes,
              })
              .from(clientProfile)
              .where(inArray(clientProfile.id, identities))
              .orderBy(asc(clientProfile.createdAt), asc(clientProfile.id))
          : [];
      return {
        client,
        appointments: await listClientAppointments(tx, id),
        ...(profiles.length ? { identity: { rootId: root.id, profiles } } : {}),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

type Editable = "name" | "phone" | "notes" | "contactDetails" | "detailsVersion";

/** Changes only what differs; the audit entry lists field names, never the values (notes are private). */
export async function updateClient(
  db: Database,
  id: string,
  input: UpdateClientRequest,
  actor: AdminActor,
  expectedUpdatedAt?: string,
): Promise<AdminClient> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(clientProfile)
      .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)))
      .for("update");
    if (!current) throw new DomainError("not_found", `Client ${id} not found`);

    requireClientRoot(current);
    if (expectedUpdatedAt && Date.parse(expectedUpdatedAt) !== current.updatedAt.getTime())
      throw new DomainError("version_conflict", "The client changed since this device reviewed it");
    const changes: Partial<Pick<typeof clientProfile.$inferInsert, Editable>> = {};
    if (input.name !== undefined && input.name !== current.name) {
      changes.name = input.name;
      if (
        input.contactDetails === undefined &&
        (current.contactDetails.firstName || current.contactDetails.lastName)
      ) {
        const { firstName: _, lastName: __, ...rest } = current.contactDetails;
        changes.contactDetails = rest;
        changes.detailsVersion = current.detailsVersion + 1;
      }
    }
    if (input.phone !== undefined && input.phone !== current.phone) changes.phone = input.phone;
    if (input.notes !== undefined && input.notes !== current.notes) changes.notes = input.notes;
    if (input.contactDetails !== undefined) {
      if (current.detailsVersion !== input.detailsVersion)
        throw new DomainError("version_conflict", "Contact details changed; reload before saving");
      changes.contactDetails = input.contactDetails;
      changes.detailsVersion = current.detailsVersion + 1;
    }
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
      .select()
      .from(clientProfile)
      .where(and(eq(clientProfile.id, id), isNull(clientProfile.deletedAt)))
      .for("update");
    if (!current) throw new DomainError("not_found", `Client ${id} not found`);

    requireClientRoot(current);
    const identities = await clientIdentityIds(tx, id);
    const [upcoming] = await tx
      .select({ id: appointment.id })
      .from(appointment)
      .where(
        and(
          inArray(appointment.clientId, identities),
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

export async function createClient(db: Database, input: CreateClientRequest, principal: Principal) {
  requirePermission(principal, "editClients");
  const fields = {
    name: input.name,
    tags: input.tags ?? [],
    contactDetails: input.contactDetails ?? {},
    phone: input.phone ?? null,
    email: input.email ?? null,
    notes: input.notes ?? null,
  };
  const digest = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`client-create:${input.id}`},0))`,
    );
    const [existing] = await tx
      .select({ id: clientProfile.id })
      .from(clientProfile)
      .where(eq(clientProfile.id, input.id));
    if (existing) {
      const [created] = await tx
        .select({ metadata: auditLog.metadata })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entity, "client"),
            eq(auditLog.entityId, input.id),
            eq(auditLog.action, "client.create"),
            eq(auditLog.actorUserId, principal.userId),
          ),
        )
        .limit(1);
      if (!created || created.metadata.requestDigest !== digest)
        throw new DomainError("invalid_state", "This contact request has already been used");
      return getAdminClient(tx, input.id);
    }
    await tx.insert(clientProfile).values({ id: input.id, ...fields });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "client.create",
      entity: "client",
      entityId: input.id,
      metadata: { requestDigest: digest },
    });
    return getAdminClient(tx, input.id);
  });
}

export async function clientGroups(db: Database) {
  const rows = await db.execute<{ name: string; count: number }>(
    sql`select ${groupName} as name, count(distinct ${clientProfile.id})::int as count
        from ${clientProfile} cross join lateral unnest(${clientProfile.tags}) as client_tag(name)
        where ${clientProfile.deletedAt} is null and ${clientProfile.mergedIntoId} is null
          and ${groupName} <> ''
        group by 1 order by 1`,
  );
  return { groups: [...rows] };
}
