import {
  appointmentListQuerySchema,
  appointmentSeriesCreateSchema,
  appointmentSeriesInputSchema,
  availabilityQuerySchema,
  bookingPromotionQuoteRequestSchema,
  calendarQuerySchema,
  createAppointmentBaseSchema,
  createAppointmentRequestSchema,
  idSchema,
  updateAppointmentRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import {
  authorizeAppointmentChange,
  authorizeAppointmentCreate,
  authorizeAppointmentList,
  authorizeCalendarQuery,
} from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { bookingOutcome } from "../../observability/booking";
import { findAvailability } from "../availability/service";
import { quoteBookingPromotion } from "../rewards/booking";
import { getCalendar } from "./calendar";
import { findAppointmentReplay } from "./replay";
import { createAppointmentSeries, getAppointmentSeries, previewAppointmentSeries } from "./series";
import {
  createAppointment,
  getAppointmentOwnership,
  listAppointments,
  loadSnapshots,
  updateAppointment,
} from "./service";

/** Mounted behind `requireAuth`, so every handler can rely on `c.get("principal")`. */
export function appointmentsRoutes({ db, now = () => new Date(), metrics }: AppDeps) {
  return (
    new Hono<AppEnv>()
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
        const scoped = authorizeAppointmentCreate(c.get("principal"), input);
        return c.json(
          await previewAppointmentSeries(
            db,
            { ...input, ...scoped, client: scoped.client, clientId: scoped.clientId },
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
        return c.json(await listAppointments(db, scoped.query, { clientId: scoped.clientId }));
      })
      // Registered before any `/:id` route so "calendar" is never read as an id.
      .get("/calendar", async (c) => {
        const query = parseOrThrow(calendarQuerySchema, c.req.query());
        const scope = authorizeCalendarQuery(c.get("principal"), query);
        return c.json(await getCalendar(db, query, scope));
      })
      .post("/", async (c) => {
        const principal = c.get("principal");
        // Clients carry no client identity (the policy pins their own profile); staff and
        // owners must name the client.
        const schema =
          principal.role === "client"
            ? createAppointmentBaseSchema
            : createAppointmentRequestSchema;
        const request = authorizeAppointmentCreate(
          principal,
          parseOrThrow(schema, await readJson(c)),
        );
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
            { userId: principal.userId },
            { now: now() },
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
      })
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
          await updateAppointment(db, id, body, { userId: principal.userId }, { now: now() }),
        );
      })
  );
}
