import {
  changeStampCardSchema,
  idSchema,
  issueStampCardSchema,
  permissionsFor,
  stampProgramInputSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { requirePermission, requireRole } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { DomainError } from "../../errors";
import { parseOrThrow, readJson } from "../../http";
import {
  changeStampCard,
  getStampProgram,
  issueStampCard,
  listStampCards,
  updateStampProgram,
} from "./stamps";

function ensureGeneration(reviewed: string, current: string) {
  if (reviewed !== current)
    throw new DomainError(
      "sync_generation_changed",
      "Review the current loyalty cards on the restored server",
    );
}

export function stampAdminRoutes({ db, config, now = () => new Date() }: AppDeps) {
  const generation = config.syncReplicaGeneration;
  return new Hono<AppEnv>()
    .use("*", async (c, next) => {
      requirePermission(c.get("principal"), "commerce");
      c.header("Cache-Control", "private, no-store");
      await next();
    })
    .get("/program", async (c) => {
      requireRole(c.get("principal"), "owner");
      return c.json(await getStampProgram(db, generation));
    })
    .put("/program", async (c) => {
      const principal = c.get("principal");
      requireRole(principal, "owner");
      const input = parseOrThrow(stampProgramInputSchema, await readJson(c));
      ensureGeneration(input.generation, generation);
      return c.json(await updateStampProgram(db, input, principal));
    })
    .get("/clients/:id", async (c) => {
      const principal = c.get("principal");
      requirePermission(principal, "clients");
      const id = parseOrThrow(idSchema, c.req.param("id"));
      return c.json({
        ...(await listStampCards(db, id, now())),
        generation,
        canEdit: permissionsFor(principal.role, principal.accessPreset).editClients,
      });
    })
    .post("/cards", async (c) => {
      requirePermission(c.get("principal"), "editClients");
      const input = parseOrThrow(issueStampCardSchema, await readJson(c));
      ensureGeneration(input.generation, generation);
      return c.json(await issueStampCard(db, input, c.get("principal"), now()), 201);
    })
    .post("/cards/:id", async (c) => {
      requirePermission(c.get("principal"), "editClients");
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const input = parseOrThrow(changeStampCardSchema, await readJson(c));
      ensureGeneration(input.generation, generation);
      return c.json(await changeStampCard(db, id, input, c.get("principal"), now()));
    });
}

export function stampClientRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono<AppEnv>().get("/loyalty-cards", async (c) => {
    const principal = c.get("principal");
    if (principal.role !== "client" || !principal.clientId)
      throw new DomainError("forbidden", "Customer account required");
    c.header("Cache-Control", "private, no-store");
    const { cards } = await listStampCards(db, principal.clientId, now());
    return c.json({ cards });
  });
}
