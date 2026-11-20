import { appointmentListQuerySchema, calendarQuerySchema } from "@sob/contracts";
import type { Database } from "@sob/db";
import { Hono } from "hono";
import { authorizeCalendarQuery, requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow } from "../../http";
import { getCalendar } from "../appointments/calendar";
import { sourceUuid } from "./plan";
import type { BooksySourceReadModel } from "./source-read-model";

/** Installed only in the explicitly configured, local consultation app, behind requireAuth. */
export function booksySourceRoutes(db: Database, model: BooksySourceReadModel) {
  const byId = new Map(model.appointments.map((a) => [a.id, a]));
  const order = new Map(
    model.base.staff.map((s) => {
      const profile = s.raw.sourceProfile as { position?: number } | undefined;
      return [
        sourceUuid(model.businessId, "staff", s.sourceId),
        profile?.position ?? Number.MAX_SAFE_INTEGER,
      ] as const;
    }),
  );
  const meta = {
    system: "booksy" as const,
    capturedAt: model.capturedAt,
    fromDate: model.fromDate,
    throughDate: model.throughDate,
    readOnly: true as const,
  };
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requireRole(c.get("principal"), "owner");
      await next();
    })
    .get("/calendar", async (c) => {
      const query = parseOrThrow(calendarQuerySchema, c.req.query());
      const scope = authorizeCalendarQuery(c.get("principal"), query);
      const native = await getCalendar(db, query, scope);
      native.staff.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      const staff = new Set(native.staff.map((s) => s.id));
      const imported = model.appointments.filter(
        (a) =>
          staff.has(a.staffId) &&
          Date.parse(a.startsAt) < Date.parse(query.to) &&
          Date.parse(a.endsAt) > Date.parse(query.from),
      );
      return c.json({
        ...native,
        importSnapshot: meta,
        appointments: [...native.appointments, ...imported].sort(
          (a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
        ),
      });
    })
    .get("/:id/context", async (c) => {
      const id = c.req.param("id");
      if (!byId.has(id)) throw new DomainError("not_found", "Appointment not found");
      return c.json(model.contexts[id]);
    })
    .get("/", async (c) => {
      const q = parseOrThrow(appointmentListQuerySchema, c.req.query());
      const all = model.appointments
        .filter(
          (a) =>
            Date.parse(a.startsAt) < Date.parse(q.to) &&
            Date.parse(a.endsAt) > Date.parse(q.from) &&
            (!q.staffId || q.staffId === a.staffId) &&
            (!q.status || q.status.includes(a.status)),
        )
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
      const page = q.page ?? 1,
        pageSize = q.pageSize ?? 50;
      return c.json({
        appointments: all.slice((page - 1) * pageSize, page * pageSize),
        page,
        pageSize,
        total: all.length,
        hasMore: page * pageSize < all.length,
      });
    });
}
