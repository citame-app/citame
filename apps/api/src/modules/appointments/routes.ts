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
  desktopSeriesCreateSchema,
  desktopSeriesInputSchema,
  desktopVisitCreateSchema,
  desktopVisitInputSchema,
  idSchema,
  permissionsFor,
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
import { compatibleBillingReasons } from "../commerce/appointment-billing";
import { quoteBookingPromotion } from "../rewards/booking";
import { bookingCombinationCatalogue } from "../services/combinations";
import { listServices } from "../services/service";
import { getRescheduleAvailability } from "./availability";
import { getCalendar, getCalendarAppointment, getCalendarWithResourceOccupancy } from "./calendar";
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
  updateAppointment,
} from "./service";
import { createVisit, getVisit, previewDesktopVisit } from "./visits";

/** Mounted behind `requireAuth`, so every handler can rely on `c.get("principal")`. */
export function appointmentsRoutes({
  db,
  config,
  now = () => new Date(),
  metrics,
  booksyNativePreview,
}: AppDeps) {
  function assertDesktopGeneration(generation: string) {
    if (generation !== config.syncReplicaGeneration)
      throw new DomainError(
        "sync_generation_changed",
        "Review the booking on the restored calendar",
      );
  }

  const seriesPreview =
    (desktop: boolean): Handler<AppEnv> =>
    async (c) => {
      const principal = c.get("principal");
      const body = await readJson(c);
      const input = desktop
        ? (() => {
            requirePermission(principal, "editCalendar");
            const { desktopGeneration, ...input } = parseOrThrow(desktopSeriesInputSchema, body);
            assertDesktopGeneration(desktopGeneration);
            return input;
          })()
        : parseOrThrow(appointmentSeriesInputSchema, body);
      const scoped = authorizeAppointmentCreate(principal, input);
      return c.json(
        await previewAppointmentSeries(
          db,
          { ...input, ...scoped, client: scoped.client, clientId: scoped.clientId },
          principal.role,
          now(),
        ),
        200,
        { "Cache-Control": "private, no-store" },
      );
    };

  const seriesCreate =
    (desktop: boolean): Handler<AppEnv> =>
    async (c) => {
      const principal = c.get("principal");
      const body = await readJson(c);
      let appointmentIds: string[] | undefined;
      const input = desktop
        ? (() => {
            requirePermission(principal, "editCalendar");
            const {
              desktopGeneration,
              appointmentIds: ids,
              ...input
            } = parseOrThrow(desktopSeriesCreateSchema, body);
            assertDesktopGeneration(desktopGeneration);
            appointmentIds = ids;
            return input;
          })()
        : parseOrThrow(appointmentSeriesCreateSchema, body);
      const scoped = authorizeAppointmentCreate(principal, input);
      return c.json(
        await createAppointmentSeries(
          db,
          { ...input, ...scoped, client: scoped.client, clientId: scoped.clientId },
          principal,
          now(),
          { appointmentIds, via: c.get("mcpAuditSource") },
        ),
        201,
      );
    };

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
      if (reviewed) assertDesktopGeneration(reviewed.desktopGeneration);
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
      .use("*", async (c, next) => {
        c.header("Cache-Control", "private, no-store");
        await next();
      })
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
      .get("/combinations", async (c) =>
        c.json(await bookingCombinationCatalogue(db, c.get("principal"))),
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
      .post("/desktop-visits/preview", async (c) => {
        const input = parseOrThrow(desktopVisitInputSchema, await readJson(c));
        assertDesktopGeneration(input.desktopGeneration);
        return c.json(await previewDesktopVisit(db, input, c.get("principal"), now()), 200, {
          "Cache-Control": "private, no-store",
        });
      })
      .post("/desktop-visits", async (c) => {
        const { reviewHash, peakPriceReviews, ...input } = parseOrThrow(
          desktopVisitCreateSchema,
          await readJson(c),
        );
        assertDesktopGeneration(input.desktopGeneration);
        return c.json(
          await createVisit(db, input, c.get("principal"), now(), reviewHash, peakPriceReviews),
          201,
        );
      })
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
      .post("/series/preview", seriesPreview(false))
      .post("/series", seriesCreate(false))
      .post("/desktop-series/preview", seriesPreview(true))
      .post("/desktop-series", seriesCreate(true))
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
        const principal = c.get("principal");
        const scope = authorizeCalendarQuery(principal, query);
        const calendar =
          query.resourceOccupancy && !booksyNativePreview
            ? await getCalendarWithResourceOccupancy(db, query, scope, now())
            : await getCalendar(db, query, scope);
        for (const entry of calendar.appointments) {
          if (entry.billingReviewReasons)
            entry.billingReviewReasons = compatibleBillingReasons(
              entry.billingReviewReasons,
              query.booksyPaymentReview === "1",
              query.booksyBalanceReview === "1",
            );
        }
        return c.json(
          booksyNativePreview ? { ...calendar, importSnapshot: booksyNativePreview } : calendar,
        );
      })
      .get("/:id/calendar-entry", async (c) => {
        const id = parseOrThrow(idSchema, c.req.param("id"));
        const scope = authorizeCalendarQuery(c.get("principal"), {});
        if (booksyNativePreview) throw new DomainError("not_found", "Appointment not found");
        const entry = await getCalendarAppointment(db, id, scope);
        if (entry.billingReviewReasons)
          entry.billingReviewReasons = compatibleBillingReasons(
            entry.billingReviewReasons,
            true,
            c.req.query("booksyBalanceReview") === "1",
          );
        return c.json(entry);
      })
      .post("/", create(false))
      .post("/desktop-booking", create(true))
      .get("/combination-availability", async (c) => {
        const principal = c.get("principal");
        requirePermission(principal, "editCalendar");
        const query = parseOrThrow(availabilityQuerySchema, c.req.query());
        if (!query.combinationId)
          throw new DomainError("validation_error", "Choose a fixed-price combination");
        if (!permissionsFor(principal.role, principal.accessPreset).allCalendars) {
          if (!principal.staffId || (query.staffId && query.staffId !== principal.staffId))
            throw new DomainError("forbidden", "Choose your own calendar");
          query.staffId = principal.staffId;
        }
        return c.json(await findAvailability(db, query, now()));
      })
      .get("/:id/availability", async (c) => {
        const id = parseOrThrow(idSchema, c.req.param("id"));
        const query = parseOrThrow(availabilityQuerySchema, c.req.query());
        return c.json(await getRescheduleAvailability(db, id, query, c.get("principal"), now()));
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
            { userId: principal.userId, role: principal.role, via: c.get("mcpAuditSource") },
            { now: now() },
          ),
        );
      })
  );
}
