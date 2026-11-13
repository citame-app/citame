import {
  createTimeOffRequestSchema,
  idSchema,
  listTimeOffQuerySchema,
  setWorkingHoursRequestSchema,
  updateStaffRequestSchema,
  updateTimeOffRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import {
  authorizeStaffAdmin,
  authorizeStaffList,
  authorizeStaffScheduleRead,
  authorizeTimeOffManage,
} from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { listAdminStaff, updateStaff } from "./admin";
import {
  createTimeOff,
  deleteTimeOff,
  getWorkingHours,
  listTimeOff,
  replaceWorkingHours,
  updateTimeOff,
} from "./schedule";

/**
 * Staff administration, mounted at `/admin/staff` behind `requireAuth`. Authorization is the
 * policy's job: the owner manages everything; staff read their own hours and manage their own
 * time off.
 */
export function staffAdminRoutes({ db, now = () => new Date() }: AppDeps) {
  const staffId = (param: string) => parseOrThrow(idSchema, param);

  return new Hono<AppEnv>()
    .get("/", async (c) => {
      const scope = authorizeStaffList(c.get("principal"));
      return c.json({ staff: await listAdminStaff(db, scope) });
    })
    .patch("/:id", async (c) => {
      const principal = c.get("principal");
      authorizeStaffAdmin(principal);
      const body = parseOrThrow(updateStaffRequestSchema, await readJson(c));
      return c.json(await updateStaff(db, staffId(c.req.param("id")), body, principal, now()));
    })
    .get("/:id/working-hours", async (c) => {
      const id = staffId(c.req.param("id"));
      authorizeStaffScheduleRead(c.get("principal"), id);
      return c.json(await getWorkingHours(db, id, now()));
    })
    .put("/:id/working-hours", async (c) => {
      const principal = c.get("principal");
      authorizeStaffAdmin(principal);
      const id = staffId(c.req.param("id"));
      const body = parseOrThrow(setWorkingHoursRequestSchema, await readJson(c));
      return c.json(await replaceWorkingHours(db, id, body, principal, now()));
    })
    .get("/:id/time-off", async (c) => {
      const id = staffId(c.req.param("id"));
      authorizeTimeOffManage(c.get("principal"), id);
      const query = parseOrThrow(listTimeOffQuerySchema, c.req.query());
      return c.json({ timeOff: await listTimeOff(db, id, query) });
    })
    .post("/:id/time-off", async (c) => {
      const principal = c.get("principal");
      const id = staffId(c.req.param("id"));
      authorizeTimeOffManage(principal, id);
      const body = parseOrThrow(createTimeOffRequestSchema, await readJson(c));
      return c.json(await createTimeOff(db, id, body, principal, now()), 201);
    })
    .patch("/:id/time-off/:timeOffId", async (c) => {
      const principal = c.get("principal");
      const id = staffId(c.req.param("id"));
      authorizeTimeOffManage(principal, id);
      const entryId = parseOrThrow(idSchema, c.req.param("timeOffId"));
      const body = parseOrThrow(updateTimeOffRequestSchema, await readJson(c));
      return c.json(await updateTimeOff(db, id, entryId, body, principal, now()));
    })
    .delete("/:id/time-off/:timeOffId", async (c) => {
      const principal = c.get("principal");
      const id = staffId(c.req.param("id"));
      authorizeTimeOffManage(principal, id);
      const entryId = parseOrThrow(idSchema, c.req.param("timeOffId"));
      return c.json(await deleteTimeOff(db, id, entryId, principal, now()));
    });
}
