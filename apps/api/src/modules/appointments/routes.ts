import {
  appointmentListQuerySchema,
  appointmentSeriesCreateSchema,
  appointmentSeriesInputSchema,
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
import { parseOrThrow, readJson } from "../../http";
import { bookingOutcome } from "../../observability/booking";
import { getCalendar } from "./calendar";
import { createAppointmentSeries, getAppointmentSeries, previewAppointmentSeries } from "./series";
import {
  createAppointment,
  getAppointmentOwnership,
  listAppointments,
  updateAppointment,
} from "./service";

/** Mounted behind `requireAuth`, so every handler can rely on `c.get("principal")`. */
export function appointmentsRoutes({ db, now = () => new Date(), metrics }: AppDeps) {
  return (
    new Hono<AppEnv>()
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
          metrics?.booking.inc({ source: "rest", outcome: bookingOutcome(error) });
          throw error;
        }
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
