import {
  appointmentContextUpdateSchema,
  appointmentListQuerySchema,
  appointmentSeriesCreateSchema,
  appointmentSeriesInputSchema,
  availabilityQuerySchema,
  bookingPromotionQuoteRequestSchema,
  booksyContextApplySchema,
  booksyContextImportSchema,
  calendarQuerySchema,
  createAppointmentBaseSchema,
  createAppointmentRequestSchema,
  desktopBookingRequestSchema,
  idSchema,
  updateAppointmentRequestSchema,
  visitCreateSchema,
} from "@sob/contracts";
import { type Handler, Hono } from "hono";
import type { AppDeps } from "../../app";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeAppointmentList,
  authorizeCalendarQuery,
  requirePermission,
} from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { bookingOutcome } from "../../observability/booking";
import { findAvailability } from "../availability/service";
import { quoteBookingPromotion } from "../rewards/booking";
import { listServices } from "../services/service";
import { getCalendar } from "./calendar";
import {
  getAppointmentContext,
  importBooksyContext,
  previewBooksyContext,
  updateAppointmentContext,
} from "./context";
import { findAppointmentReplay } from "./replay";
import { createAppointmentSeries, getAppointmentSeries, previewAppointmentSeries } from "./series";
import {
  createAppointment,
  getAppointmentOwnership,
  listAppointments,
  loadSnapshots,
  updateAppointment,
} from "./service";
import { createVisit, getVisit } from "./visits";

/** Mounted behind `requireAuth`, so every handler can rely on `c.get("principal")`. */
export function appointmentsRoutes({
  db,
  config,
  now = () => new Date(),
  metrics,
  booksyNativePreview,
}: AppDeps) {
  const create =
    (desktopBooking: boolean): Handler<AppEnv> =>
    async (c) => {
      const principal = c.get("principal");
      if (desktopBooking && principal.role === "client")
        throw new DomainError("forbidden", "A centre account is required");
      // Clients carry no client identity (the policy pins their own profile); staff and
      // owners must name the client.
      const schema =
        principal.role === "client" ? createAppointmentBaseSchema : createAppointmentRequestSchema;
      const body = await readJson(c);
      const reviewed = desktopBooking ? parseOrThrow(desktopBookingRequestSchema, body) : undefined;
      if (reviewed && reviewed.desktopGeneration !== config.syncReplicaGeneration) {
        throw new DomainError(
          "sync_generation_changed",
          "Review the booking on the restored calendar",
        );
      }
      const request = authorizeAppointmentCreate(principal, reviewed ?? parseOrThrow(schema, body));
      const replay = async () => {
        const existing = await findAppointmentReplay(db, request, principal.userId);
        if (!existing) return null;
        c.header("x-idempotent-replay", "true");
        return c.json(existing, 201);
      };
      const previous = await replay();
      if (previous) return previous;
      try {
        const created = await createAppointment(
          db,
          request,
          { userId: principal.userId, role: principal.role },
          { now: now(), desktopReviewed: desktopBooking },
        );
        metrics?.booking.inc({ source: "rest", outcome: "created" });
        return c.json(created, 201);
      } catch (error) {
        // Another identical request may have committed while this one waited for locks.
        if (error instanceof DomainError) {
          const existing = await replay();
          if (existing) return existing;
        }
        metrics?.booking.inc({ source: "rest", outcome: bookingOutcome(error) });
        throw error;
      }
    };
  return (
    new Hono<AppEnv>()
      .post("/booksy-context/preview", async (c) =>
        c.json(
          await previewBooksyContext(
            db,
            parseOrThrow(booksyContextImportSchema, await readJson(c)),
            c.get("principal"),
            now(),
          ),
        ),
      )
      .post("/booksy-context/import", async (c) => {
        const request = parseOrThrow(booksyContextApplySchema, await readJson(c));
        return c.json(
          await importBooksyContext(
            db,
            request.input,
            request.reviewHash,
            c.get("principal"),
            now(),
          ),
        );
      })
      .get("/:id/context", async (c) =>
        c.json(
          await db.transaction(
            (tx) =>
              getAppointmentContext(
                tx,
                parseOrThrow(idSchema, c.req.param("id")),
                c.get("principal"),
              ),
            { isolationLevel: "repeatable read", accessMode: "read only" },
          ),
          200,
          { "Cache-Control": "private, no-store" },
        ),
      )
      .patch("/:id/context", async (c) =>
        c.json(
          await updateAppointmentContext(
            db,
            parseOrThrow(idSchema, c.req.param("id")),
            parseOrThrow(appointmentContextUpdateSchema, await readJson(c)),
            c.get("principal"),
            now(),
          ),
          200,
          { "Cache-Control": "private, no-store" },
        ),
      )
      .get("/catalog", async (c) => {
        requirePermission(c.get("principal"), "editCalendar");
        return c.json({ services: await listServices(db, true) });
      })
      .post("/visits", async (c) =>
        c.json(
          await createVisit(
            db,
            parseOrThrow(visitCreateSchema, await readJson(c)),
            c.get("principal"),
            now(),
          ),
          201,
        ),
      )
      .get("/visits/:id", async (c) =>
        c.json(await getVisit(db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal"))),
      )
      .post("/promotion-quote", async (c) =>
        c.json(
          await quoteBookingPromotion(
            db,
            parseOrThrow(bookingPromotionQuoteRequestSchema, await readJson(c)),
            c.get("principal"),
            now(),
          ),
        ),
      )
      .post("/series/preview", async (c) => {
        const input = parseOrThrow(appointmentSeriesInputSchema, await readJson(c));
        const principal = c.get("principal");
        const scoped = authorizeAppointmentCreate(principal, input);
        return c.json(
          await previewAppointmentSeries(
            db,
            { ...input, ...scoped, client: scoped.client, clientId: scoped.clientId },
            principal.role,
            now(),
          ),
        );
      })
      .post("/series", async (c) => {
        const input = parseOrThrow(appointmentSeriesCreateSchema, await readJson(c));
        const principal = c.get("principal");
        const scoped = authorizeAppointmentCreate(principal, input);
        return c.json(
          await createAppointmentSeries(
            db,
            { ...input, ...scoped, client: scoped.client, clientId: scoped.clientId },
            principal,
            now(),
          ),
          201,
        );
      })
      .get("/series/:id", async (c) =>
        c.json(
          await getAppointmentSeries(
            db,
            parseOrThrow(idSchema, c.req.param("id")),
            c.get("principal"),
          ),
        ),
      )
      .get("/", async (c) => {
        const query = parseOrThrow(appointmentListQuerySchema, c.req.query());
        const scoped = authorizeAppointmentList(c.get("principal"), query);
        return c.json(
          await listAppointments(db, scoped.query, {
            clientId: scoped.clientId,
            clientIds: scoped.clientIds,
          }),
        );
      })
      // Registered before any `/:id` route so "calendar" is never read as an id.
      .get("/calendar", async (c) => {
        const query = parseOrThrow(calendarQuerySchema, c.req.query());
        const scope = authorizeCalendarQuery(c.get("principal"), query);
        const calendar = await getCalendar(db, query, scope);
        return c.json(
          booksyNativePreview ? { ...calendar, importSnapshot: booksyNativePreview } : calendar,
        );
      })
      .post("/", create(false))
      .post("/desktop-booking", create(true))
      .get("/:id/availability", async (c) => {
        const id = parseOrThrow(idSchema, c.req.param("id"));
        const query = parseOrThrow(availabilityQuerySchema, c.req.query());
        const ownership = await getAppointmentOwnership(db, id);
        authorizeAppointmentChange(
          c.get("principal"),
          ownership,
          {
            version: 1,
            staffId: query.staffId,
          },
          now(),
        );
        const snapshots = (await loadSnapshots(db, [id])).get(id) ?? [];
        snapshots.sort((a, b) => a.position - b.position);
        if (
          !snapshots.length ||
          snapshots.length !== query.serviceIds.length ||
          snapshots.some((s, i) => !s.serviceId || s.serviceId !== query.serviceIds[i])
        )
          throw new DomainError("validation_error", "Rescheduling must retain the booked services");
        return c.json(
          await findAvailability(db, query, now(), {
            excludeAppointmentId: id,
            services: snapshots.map((s) => ({
              id: s.serviceId ?? s.id,
              durationMinutes: s.durationMinutes,
              bufferMinutes: s.bufferMinutes,
              ...(s.processingStartMinutes !== null && s.processingMinutes !== null
                ? {
                    processing: {
                      startsAfterMinutes: s.processingStartMinutes,
                      minutes: s.processingMinutes,
                    },
                  }
                : {}),
            })),
          }),
        );
      })
      .patch("/:id", async (c) => {
        const id = parseOrThrow(idSchema, c.req.param("id"));
        const body = parseOrThrow(updateAppointmentRequestSchema, await readJson(c));
        const principal = c.get("principal");
        authorizeAppointmentChange(principal, await getAppointmentOwnership(db, id), body, now());
        return c.json(
          await updateAppointment(
            db,
            id,
            body,
            { userId: principal.userId, role: principal.role },
            { now: now() },
          ),
        );
      })
  );
}
