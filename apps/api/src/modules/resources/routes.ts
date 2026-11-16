import { idSchema, resourceCreateSchema, resourceUpdateSchema } from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { createResource, listResources, updateResource } from "./catalog";
export function resourceRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/", async (c) => c.json(await listResources(db, c.get("principal"))))
    .post("/", async (c) =>
      c.json(
        await createResource(
          db,
          parseOrThrow(resourceCreateSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .put("/:id", async (c) =>
      c.json(
        await updateResource(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(resourceUpdateSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      ),
    );
}
