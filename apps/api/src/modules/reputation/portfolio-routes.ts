import {
  idSchema,
  portfolioEditSchema,
  portfolioPublishSchema,
  portfolioQuerySchema,
  portfolioRemoveSchema,
  portfolioUploadSchema,
  portfolioVersionSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import {
  changePortfolio,
  listPortfolioAdmin,
  listPortfolioPublic,
  portfolioImage,
  uploadPortfolio,
} from "./portfolio";

const router = () =>
  new Hono<AppEnv>().use("*", async (c, next) => {
    c.header("cache-control", "private, no-store");
    await next();
  });
export function portfolioPublicRoutes({ db }: AppDeps) {
  return router()
    .get("/", async (c) =>
      c.json(await listPortfolioPublic(db, parseOrThrow(portfolioQuerySchema, c.req.query()))),
    )
    .get("/:id/image", (c) => portfolioImage(db, parseOrThrow(idSchema, c.req.param("id"))));
}
export function portfolioAdminRoutes({ db, config, now = () => new Date() }: AppDeps) {
  const generation = config.syncReplicaGeneration;
  function checked<T extends { generation?: string }>(input: T, desktop: boolean | undefined) {
    if ((desktop || input.generation !== undefined) && input.generation !== generation) {
      throw new DomainError("sync_generation_changed", "Refresh the gallery after the restore");
    }
    return input;
  }
  return router()
    .get("/", async (c) =>
      c.json({ ...(await listPortfolioAdmin(db, c.get("principal"))), generation }),
    )
    .get("/:id/image", (c) =>
      portfolioImage(db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
    )
    .post("/", async (c) =>
      c.json(
        await uploadPortfolio(
          db,
          checked(parseOrThrow(portfolioUploadSchema, await readJson(c)), c.get("desktopRequest")),
          c.get("principal"),
          now(),
        ),
        201,
      ),
    )
    .put("/:id", async (c) =>
      c.json(
        await changePortfolio(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          {
            kind: "edit",
            input: checked(
              parseOrThrow(portfolioEditSchema, await readJson(c)),
              c.get("desktopRequest"),
            ),
          },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/publish", async (c) =>
      c.json(
        await changePortfolio(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          {
            kind: "publish",
            input: checked(
              parseOrThrow(portfolioPublishSchema, await readJson(c)),
              c.get("desktopRequest"),
            ),
          },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/unpublish", async (c) =>
      c.json(
        await changePortfolio(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          {
            kind: "unpublish",
            input: checked(
              parseOrThrow(portfolioVersionSchema, await readJson(c)),
              c.get("desktopRequest"),
            ),
          },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/remove", async (c) =>
      c.json(
        await changePortfolio(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          {
            kind: "remove",
            input: checked(
              parseOrThrow(portfolioRemoveSchema, await readJson(c)),
              c.get("desktopRequest"),
            ),
          },
          c.get("principal"),
          now(),
        ),
      ),
    );
}
