import {
  bookingPolicyInputSchema,
  initialSyncGeneration,
  reviewedBookingPolicyInputSchema,
  reviewedBusinessProfileRequestSchema,
  reviewedSalonSettingsRequestSchema,
  updateSalonSettingsRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { getBookingPolicy, publishBookingPolicy } from "../booking-protection/policy";
import {
  getSalonSettings,
  toOwnerSettings,
  toReviewedSettings,
  updateReviewedSettings,
  updateSalonSettings,
} from "./service";

/** Owner-only salon settings, mounted at `/admin/settings` behind `requireAuth`. */
export function settingsAdminRoutes({ db, config }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/booking-policy", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(await getBookingPolicy(db));
    })
    .put("/booking-policy", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const policy = parseOrThrow(bookingPolicyInputSchema, await readJson(c));
      const saved = await publishBookingPolicy(
        db,
        { generation: initialSyncGeneration, policy },
        principal,
        config.syncReplicaGeneration,
      );
      return c.json(saved.policy);
    })
    .get("/booking-policy/reviewed", async (c) => {
      requireRole(c.get("principal"), "owner");
      c.header("Cache-Control", "private, no-store");
      return c.json({
        generation: config.syncReplicaGeneration,
        policy: await getBookingPolicy(db),
      });
    })
    .put("/booking-policy/reviewed", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const reviewed = parseOrThrow(reviewedBookingPolicyInputSchema, await readJson(c));
      return c.json(
        await publishBookingPolicy(db, reviewed, principal, config.syncReplicaGeneration),
      );
    })
    .get("/", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(toOwnerSettings(await getSalonSettings(db)));
    })
    .get("/desktop", async (c) => {
      requireRole(c.get("principal"), "owner");
      c.header("Cache-Control", "private, no-store");
      return c.json({
        ...toReviewedSettings(await getSalonSettings(db)),
        generation: config.syncReplicaGeneration,
      });
    })
    .put("/profile", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const { generation, expectedRevision, changes } = parseOrThrow(
        reviewedBusinessProfileRequestSchema,
        await readJson(c),
      );
      if (generation !== config.syncReplicaGeneration)
        throw new DomainError(
          "version_conflict",
          "The salon settings were restored; review them again",
        );
      const saved = await updateReviewedSettings(
        db,
        { businessProfile: changes },
        principal,
        expectedRevision,
      );
      return c.json({ ...saved, generation }, 200, { "Cache-Control": "private, no-store" });
    })
    .put("/desktop", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const { expectedRevision, changes } = parseOrThrow(
        reviewedSalonSettingsRequestSchema,
        await readJson(c),
      );
      if (changes.businessProfile !== undefined)
        throw new DomainError(
          "version_conflict",
          "The business profile requires a reviewed generation",
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
