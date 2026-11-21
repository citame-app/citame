import {
  bookingPolicyInputSchema,
  reviewedSalonSettingsRequestSchema,
  updateSalonSettingsRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { getBookingPolicy, setBookingPolicy } from "../booking-protection/policy";
import {
  getSalonSettings,
  toOwnerSettings,
  toReviewedSettings,
  updateReviewedSettings,
  updateSalonSettings,
} from "./service";

/** Owner-only salon settings, mounted at `/admin/settings` behind `requireAuth`. */
export function settingsAdminRoutes({ db }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/booking-policy", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(await getBookingPolicy(db));
    })
    .put("/booking-policy", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(
        await setBookingPolicy(
          db,
          parseOrThrow(bookingPolicyInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      );
    })
    .get("/", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(toOwnerSettings(await getSalonSettings(db)));
    })
    .get("/desktop", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(toReviewedSettings(await getSalonSettings(db)));
    })
    .put("/desktop", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const { expectedRevision, changes } = parseOrThrow(
        reviewedSalonSettingsRequestSchema,
        await readJson(c),
      );
      return c.json(await updateReviewedSettings(db, changes, principal, expectedRevision));
    })
    .patch("/", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const body = parseOrThrow(updateSalonSettingsRequestSchema, await readJson(c));
      return c.json(await updateSalonSettings(db, body, principal));
    });
}
