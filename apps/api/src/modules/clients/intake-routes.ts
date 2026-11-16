import {
  idSchema,
  intakeCreateInputSchema,
  intakeDraftInputSchema,
  intakeRequirementsQuerySchema,
  intakeSubmissionInputSchema,
  intakeSubmissionsQuerySchema,
  intakeVersionInputSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission } from "../../auth/policy";
import type { AppEnv, Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import {
  archiveIntakeForm,
  createIntakeForm,
  getIntakeRequirements,
  getIntakeSubmission,
  listIntakeForms,
  listIntakeSubmissions,
  publishIntakeForm,
  submitIntakeResponse,
  updateIntakeDraft,
} from "./intake";

function privateRouter() {
  return new Hono<AppEnv>().use("*", async (c, next) => {
    c.header("cache-control", "private, no-store");
    await next();
  });
}

export function intakeAdminRoutes({ db, now = () => new Date() }: AppDeps) {
  return privateRouter()
    .get("/", async (c) => c.json(await listIntakeForms(db, c.get("principal"))))
    .post("/", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "deleteClients");
      return c.json(
        await createIntakeForm(
          db,
          parseOrThrow(intakeCreateInputSchema, await readJson(c)),
          principal,
          now(),
        ),
        201,
      );
    })
    .put("/:id", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "deleteClients");
      return c.json(
        await updateIntakeDraft(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(intakeDraftInputSchema, await readJson(c)),
          principal,
          now(),
        ),
      );
    })
    .post("/:id/publish", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "deleteClients");
      return c.json(
        await publishIntakeForm(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(intakeVersionInputSchema, await readJson(c)).version,
          principal,
          now(),
        ),
      );
    })
    .post("/:id/archive", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "deleteClients");
      return c.json(
        await archiveIntakeForm(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(intakeVersionInputSchema, await readJson(c)).version,
          principal,
          now(),
        ),
      );
    });
}
export function intakeRoutes({ db, now = () => new Date() }: AppDeps) {
  return privateRouter()
    .get("/requirements", async (c) =>
      c.json(
        await getIntakeRequirements(
          db,
          parseOrThrow(intakeRequirementsQuerySchema, c.req.query()).serviceIds,
          c.get("principal"),
          now(),
          parseOrThrow(intakeRequirementsQuerySchema, c.req.query()).clientId,
        ),
      ),
    )
    .get("/submissions/:id", async (c) =>
      c.json(
        await getIntakeSubmission(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          c.get("principal"),
        ),
      ),
    );
}
function ownClient(principal: Principal) {
  if (principal.role !== "client" || !principal.clientId)
    throw new DomainError("forbidden", "This account has no client profile");
  return principal.clientId;
}
export function intakeSelfRoutes({ db, now = () => new Date() }: AppDeps) {
  return privateRouter()
    .get("/", async (c) =>
      c.json(
        await listIntakeSubmissions(
          db,
          ownClient(c.get("principal")),
          c.get("principal"),
          parseOrThrow(intakeSubmissionsQuerySchema, c.req.query()).before,
        ),
      ),
    )
    .post("/", async (c) =>
      c.json(
        await submitIntakeResponse(
          db,
          ownClient(c.get("principal")),
          parseOrThrow(intakeSubmissionInputSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
        201,
      ),
    );
}
export function intakeClientRoutes({ db, now = () => new Date() }: AppDeps) {
  return privateRouter()
    .get("/:id/intake", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "clients");
      return c.json(
        await listIntakeSubmissions(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          principal,
          parseOrThrow(intakeSubmissionsQuerySchema, c.req.query()).before,
        ),
      );
    })
    .post("/:id/intake", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "editClients");
      return c.json(
        await submitIntakeResponse(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(intakeSubmissionInputSchema, await readJson(c)),
          principal,
          now(),
        ),
        201,
      );
    });
}
