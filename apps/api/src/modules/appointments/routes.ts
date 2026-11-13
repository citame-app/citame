import {
  appointmentListQuerySchema,
  createAppointmentRequestSchema,
  idSchema,
  updateAppointmentRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { parseOrThrow, readJson } from "../../http";
import { createAppointment, listAppointments, updateAppointment } from "./service";

export function appointmentsRoutes({ db }: AppDeps) {
  return new Hono()
    .get("/", async (c) => {
      const query = parseOrThrow(appointmentListQuerySchema, c.req.query());
      return c.json({ appointments: await listAppointments(db, query) });
    })
    .post("/", async (c) => {
      const body = parseOrThrow(createAppointmentRequestSchema, await readJson(c));
      return c.json(await createAppointment(db, body), 201);
    })
    .patch("/:id", async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(updateAppointmentRequestSchema, await readJson(c));
      return c.json(await updateAppointment(db, id, body));
    });
}
