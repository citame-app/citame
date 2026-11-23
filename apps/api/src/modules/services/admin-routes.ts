import {
  combinationCreateSchema,
  combinationListQuerySchema,
  combinationUpdateSchema,
  createServiceRequestSchema,
  idSchema,
  reviewedServiceUpdateSchema,
  serviceCatalogUpdateSchema,
  serviceConfigurationSchema,
  serviceProcessingInputSchema,
  serviceResourceInputSchema,
  setServiceStaffRequestSchema,
  updateServiceRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { AppDeps } from "../../app";
import { authorizeServiceAdmin } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import {
  getReviewedServiceResources,
  getServiceResources,
  setServiceResources,
} from "../resources/catalog";
import {
  createService,
  deactivateService,
  listAdminServices,
  setServiceStaff,
  updateService,
  updateServiceCatalog,
  updateServiceConfiguration,
} from "./admin";

import { listCombinations, saveCombination } from "./combinations";

import { setServiceProcessing } from "./processing";

const ownerOnly = createMiddleware<AppEnv>(async (c, next) => {
  authorizeServiceAdmin(c.get("principal"));
  await next();
});

/** Owner-only catalog administration, mounted at `/admin/services` behind `requireAuth`. */
export function serviceAdminRoutes({ db, config, now = () => new Date() }: AppDeps) {
  return new Hono<AppEnv>()
    .put("/:id/processing", ownerOnly, async (c) =>
      c.json(
        await setServiceProcessing(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(serviceProcessingInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .get("/combinations", ownerOnly, async (c) => {
      const query = parseOrThrow(combinationListQuerySchema, c.req.query());
      return c.json(await listCombinations(db, c.get("principal"), query.fixedTerms === "1"));
    })
    .post("/combinations", ownerOnly, async (c) =>
      c.json(
        await saveCombination(
          db,
          parseOrThrow(combinationCreateSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
        201,
      ),
    )
    .put("/combinations/:combinationId", ownerOnly, async (c) =>
      c.json(
        await saveCombination(
          db,
          parseOrThrow(combinationUpdateSchema, await readJson(c)),
          c.get("principal"),
          now(),
          { kind: "update", id: parseOrThrow(idSchema, c.req.param("combinationId")) },
        ),
      ),
    )
    .get("/", ownerOnly, async (c) => c.json({ services: await listAdminServices(db) }))
    .get("/reviewed", ownerOnly, async (c) =>
      c.json({ generation: config.syncReplicaGeneration, services: await listAdminServices(db) }),
    )
    .put("/:id/reviewed", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const input = parseOrThrow(reviewedServiceUpdateSchema, await readJson(c));
      if (input.generation !== config.syncReplicaGeneration)
        throw new DomainError(
          "sync_generation_changed",
          "The centre was restored; review the service",
        );
      return c.json(await updateService(db, id, input.service, c.get("principal"), input.version));
    })
    .post("/", ownerOnly, async (c) => {
      const body = parseOrThrow(createServiceRequestSchema, await readJson(c));
      return c.json(await createService(db, body, c.get("principal")), 201);
    })
    .get("/:id/resources", ownerOnly, async (c) =>
      c.json(
        await getServiceResources(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
        ),
      ),
    )
    .get("/:id/resources/reviewed", ownerOnly, async (c) =>
      c.json(
        await getReviewedServiceResources(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          config.syncReplicaGeneration,
        ),
      ),
    )
    .put("/:id/resources", ownerOnly, async (c) =>
      c.json(
        await setServiceResources(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(serviceResourceInputSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      ),
    )
    .put("/:id/configuration", ownerOnly, async (c) =>
      c.json(
        await updateServiceConfiguration(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(serviceConfigurationSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .put("/:id/catalog", ownerOnly, async (c) =>
      c.json(
        await updateServiceCatalog(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(serviceCatalogUpdateSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .patch("/:id", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(updateServiceRequestSchema, await readJson(c));
      return c.json(await updateService(db, id, body, c.get("principal")));
    })
    .delete("/:id", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      return c.json(await deactivateService(db, id, c.get("principal")));
    })
    .put("/:id/staff", ownerOnly, async (c) => {
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(setServiceStaffRequestSchema, await readJson(c));
      return c.json(await setServiceStaff(db, id, body, c.get("principal")));
    });
}
