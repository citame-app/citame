import {
  idSchema,
  reviewAdminQuerySchema,
  reviewCreateSchema,
  reviewEditSchema,
  reviewModerationSchema,
  reviewPrivateQuerySchema,
  reviewPublicQuerySchema,
  reviewReplySchema,
  reviewVersionSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import {
  adminReviews,
  changeReview,
  createReview,
  ownReviews,
  publicReviews,
  reviewForSocial,
} from "./reviews";

const router = () =>
  new Hono<AppEnv>().use("*", async (c, next) => {
    c.header("cache-control", "private, no-store");
    await next();
  });
export function reviewPublicRoutes({ db, now = () => new Date() }: AppDeps) {
  return router().get("/", async (c) =>
    c.json(await publicReviews(db, parseOrThrow(reviewPublicQuerySchema, c.req.query()), now())),
  );
}
export function reviewSelfRoutes({ db, now = () => new Date() }: AppDeps) {
  return router()
    .post("/:id/revoke-social", async (c) =>
      c.json(
        await changeReview(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          { kind: "revokeSocial", input: parseOrThrow(reviewVersionSchema, await readJson(c)) },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .get("/", async (c) =>
      c.json(
        await ownReviews(
          db,
          c.get("principal"),
          parseOrThrow(reviewPrivateQuerySchema, c.req.query()),
          now(),
        ),
      ),
    )
    .post("/", async (c) =>
      c.json(
        await createReview(
          db,
          parseOrThrow(reviewCreateSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
        201,
      ),
    )
    .put("/:id", async (c) =>
      c.json(
        await changeReview(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          { kind: "edit", input: parseOrThrow(reviewEditSchema, await readJson(c)) },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/withdraw", async (c) =>
      c.json(
        await changeReview(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          { kind: "withdraw", input: parseOrThrow(reviewVersionSchema, await readJson(c)) },
          c.get("principal"),
          now(),
        ),
      ),
    );
}
export function reviewAdminRoutes({ db, now = () => new Date() }: AppDeps) {
  return router()
    .get("/:id/social", async (c) =>
      c.json(
        await reviewForSocial(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
          now(),
        ),
      ),
    )
    .get("/", async (c) =>
      c.json(
        await adminReviews(
          db,
          c.get("principal"),
          parseOrThrow(reviewAdminQuerySchema, c.req.query()),
          now(),
        ),
      ),
    )
    .put("/:id/moderation", async (c) =>
      c.json(
        await changeReview(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          { kind: "moderate", input: parseOrThrow(reviewModerationSchema, await readJson(c)) },
          c.get("principal"),
          now(),
        ),
      ),
    )
    .put("/:id/reply", async (c) =>
      c.json(
        await changeReview(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          { kind: "reply", input: parseOrThrow(reviewReplySchema, await readJson(c)) },
          c.get("principal"),
          now(),
        ),
      ),
    );
}
