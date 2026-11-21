import {
  createTimeOffRequestSchema,
  dateShiftCommitSchema,
  dateShiftInputSchema,
  dateShiftsQuerySchema,
  idSchema,
  listTimeOffQuerySchema,
  permissionsFor,
  reviewedStaffAccessInputSchema,
  setWorkingHoursRequestSchema,
  staffAccessInputSchema,
  staffCapacityInputSchema,
  staffPortraitInputSchema,
  staffPortraitPublicationSchema,
  teamShiftWeekQuerySchema,
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
  requirePermission,
  requireRole,
} from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { getReviewedStaffAccess, setStaffAccess } from "./access";
import { listAdminStaff, updateStaff } from "./admin";
import { getStaffCapacity, setStaffCapacity } from "./capacity";
import { commitDateShifts, getDateShifts, previewDateShifts } from "./date-shifts";
import { readStaffPortrait, saveStaffPortrait } from "./portrait";
import {
  createTimeOff,
  deleteTimeOff,
  getWorkingHours,
  listTimeOff,
  replaceWorkingHours,
  updateTimeOff,
} from "./schedule";
import { getTeamShiftWeek } from "./team-shifts";

/**
 * Staff administration, mounted at `/admin/staff` behind `requireAuth`. Authorization is the
 * policy's job: the owner manages everything; staff read their own hours and manage their own
 * time off.
 */
export function staffAdminRoutes({ db, config, now = () => new Date() }: AppDeps) {
  const staffId = (param: string) => parseOrThrow(idSchema, param);

  return new Hono<AppEnv>()
    .get("/:id/portrait", (c) =>
      readStaffPortrait(
        db,
        staffId(c.req.param("id")),
        c.get("principal"),
        c.req.query("v") === undefined ? undefined : parseOrThrow(idSchema, c.req.query("v")),
      ),
    )
    .put("/:id/portrait", async (c) =>
      c.json(
        await saveStaffPortrait(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(staffPortraitInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .put("/:id/portrait/publication", async (c) =>
      c.json(
        await saveStaffPortrait(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(staffPortraitPublicationSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/:id/capacity", async (c) =>
      c.json(await getStaffCapacity(db, staffId(c.req.param("id")), c.get("principal"))),
    )
    .put("/:id/capacity", async (c) =>
      c.json(
        await setStaffCapacity(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(staffCapacityInputSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      ),
    )
    .get("/", async (c) => {
      const principal = c.get("principal");
      const scope = authorizeStaffList(principal);
      c.header("cache-control", "private, no-store");
      return c.json({
        staff: await listAdminStaff(db, scope),
        canEditPortraits: permissionsFor(principal.role, principal.accessPreset).editSchedules,
      });
    })
    .get("/team-shifts", async (c) => {
      requirePermission(c.get("principal"), "editSchedules");
      c.header("cache-control", "private, no-store");
      const { week } = parseOrThrow(teamShiftWeekQuerySchema, c.req.query());
      return c.json(await getTeamShiftWeek(db, week));
    })
    .get("/:id/date-shifts", async (c) => {
      c.header("cache-control", "private, no-store");
      const query = parseOrThrow(dateShiftsQuerySchema, c.req.query());
      return c.json(
        await getDateShifts(
          db,
          staffId(c.req.param("id")),
          query.from,
          query.to,
          c.get("principal"),
          now(),
        ),
      );
    })
    .post("/:id/date-shifts/preview", async (c) => {
      c.header("cache-control", "private, no-store");
      return c.json(
        await previewDateShifts(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(dateShiftInputSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      );
    })
    .post("/:id/date-shifts", async (c) => {
      c.header("cache-control", "private, no-store");
      return c.json(
        await commitDateShifts(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(dateShiftCommitSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
        201,
      );
    })
    .get("/:id/access/reviewed", async (c) => {
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await getReviewedStaffAccess(
          db,
          staffId(c.req.param("id")),
          c.get("principal"),
          config.syncReplicaGeneration,
        ),
      );
    })
    .put("/:id/access/reviewed", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      c.header("Cache-Control", "private, no-store");
      return c.json(
        await setStaffAccess(
          db,
          staffId(c.req.param("id")),
          parseOrThrow(reviewedStaffAccessInputSchema, await readJson(c)),
          principal,
          config.syncReplicaGeneration,
        ),
      );
    })
    .get("/:id/access", async (c) => {
      c.header("Cache-Control", "private, no-store");
      const { access } = await getReviewedStaffAccess(
        db,
        staffId(c.req.param("id")),
        c.get("principal"),
        config.syncReplicaGeneration,
      );
      return c.json(access);
    })
    .put("/:id/access", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      c.header("Cache-Control", "private, no-store");
      const { access } = await setStaffAccess(
        db,
        staffId(c.req.param("id")),
        parseOrThrow(staffAccessInputSchema, await readJson(c)),
        principal,
        config.syncReplicaGeneration,
      );
      return c.json(access);
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
      return c.json(await getWorkingHours(db, id, now(), config.syncReplicaGeneration));
    })
    .put("/:id/working-hours", async (c) => {
      const principal = c.get("principal");
      authorizeStaffAdmin(principal);
      const id = staffId(c.req.param("id"));
      const body = parseOrThrow(setWorkingHoursRequestSchema, await readJson(c));
      return c.json(
        await replaceWorkingHours(db, id, body, principal, now(), {
          generation: config.syncReplicaGeneration,
          requireRevision: c.get("desktopRequest") === true,
        }),
      );
    })
    .get("/:id/time-off", async (c) => {
      const id = staffId(c.req.param("id"));
      authorizeStaffScheduleRead(c.get("principal"), id);
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
