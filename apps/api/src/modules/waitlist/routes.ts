import {
  idSchema,
  scheduleAccessScope,
  WAITLIST_ACCESS_SCOPE_HEADER,
  waitlistAcceptSchema,
  waitlistAdminInputSchema,
  waitlistCancelSchema,
  waitlistDeclineSchema,
  waitlistInputSchema,
  waitlistPolicySchema,
  waitlistQuerySchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission, requireRole } from "../../auth/policy";
import type { AppEnv, Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import { acceptWaitlist } from "./accept";
import {
  endWaitlist,
  joinWaitlist,
  listImportedWaitlist,
  listWaitlist,
  reviewWaitlistOffer,
  setWaitlistPolicy,
} from "./service";

function requireWaitlistScope(expected: string | undefined, principal: Principal) {
  if (expected !== undefined && expected !== scheduleAccessScope(principal))
    throw new DomainError("forbidden", "Waitlist access scope changed");
}

function entryActions(app: Hono<AppEnv>, { db, now = () => new Date() }: AppDeps) {
  return app
    .post("/:id/cancel", async (c) =>
      c.json(
        await endWaitlist(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(waitlistCancelSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/decline", async (c) =>
      c.json(
        await endWaitlist(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(waitlistDeclineSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      ),
    )
    .post("/:id/accept", async (c) =>
      c.json(
        await acceptWaitlist(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(waitlistAcceptSchema, await readJson(c)),
          c.get("principal"),
          now(),
          c.get("mcpAuditSource"),
        ),
        201,
      ),
    );
}
export function waitlistClientRoutes(deps: AppDeps) {
  const { db, now = () => new Date() } = deps;
  return entryActions(
    new Hono<AppEnv>()
      .use("*", async (c, next) => {
        requireRole(c.get("principal"), "client");
        await next();
      })
      .get("/", async (c) => {
        const principal = c.get("principal");
        c.header("Cache-Control", "private, no-store");
        requireWaitlistScope(c.req.header(WAITLIST_ACCESS_SCOPE_HEADER), principal);
        return c.json(
          await listWaitlist(db, principal, parseOrThrow(waitlistQuerySchema, c.req.query())),
        );
      })
      .post("/", async (c) =>
        c.json(
          await joinWaitlist(
            db,
            parseOrThrow(waitlistInputSchema, await readJson(c)),
            c.get("principal"),
            now(),
          ),
          201,
        ),
      ),
    deps,
  );
}
export function waitlistAdminRoutes(deps: AppDeps) {
  const { db, now = () => new Date() } = deps;
  return entryActions(
    new Hono<AppEnv>()
      .use("*", async (c, next) => {
        requirePermission(c.get("principal"), "clients");
        requirePermission(c.get("principal"), "editCalendar");
        await next();
      })
      .get("/:id/offer-review", async (c) => {
        const id = parseOrThrow(idSchema, c.req.param("id"));
        const review = await reviewWaitlistOffer(db, id, c.get("principal"), now());
        return c.json(review, 200, { "Cache-Control": "private, no-store" });
      })
      .put("/policy", async (c) =>
        c.json(
          await setWaitlistPolicy(
            db,
            parseOrThrow(waitlistPolicySchema.strict(), await readJson(c)),
            c.get("principal"),
          ),
        ),
      )
      .get("/", async (c) => {
        const principal = c.get("principal");
        c.header("Cache-Control", "private, no-store");
        requireWaitlistScope(c.req.header(WAITLIST_ACCESS_SCOPE_HEADER), principal);
        const query = parseOrThrow(waitlistQuerySchema, c.req.query());
        const [list, imported] = await Promise.all([
          listWaitlist(db, principal, query),
          listImportedWaitlist(db, principal, query),
        ]);
        return c.json({ ...list, ...(imported.length ? { imported } : {}) });
      })
      .post("/", async (c) => {
        const { clientId, importedEntryId, ...input } = parseOrThrow(
          waitlistAdminInputSchema,
          await readJson(c),
        );
        return c.json(
          await joinWaitlist(db, input, c.get("principal"), now(), clientId, importedEntryId),
          201,
        );
      }),
    deps,
  );
}
