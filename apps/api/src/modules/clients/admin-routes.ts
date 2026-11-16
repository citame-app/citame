import {
  clientControlsInputSchema,
  clientExportQuerySchema,
  clientImportInputSchema,
  clientImportPreviewInputSchema,
  clientListQuerySchema,
  idSchema,
  updateClientRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { authorizeClientAccess, authorizeClientDelete } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import { deleteClient, getClientDetail, listClients, updateClient } from "./admin";
import { getClientControls, updateClientControls } from "./controls";
import { exportClients, importClients, previewClientImport } from "./transfer";

/** Client directory, mounted at `/admin/clients` behind `requireAuth`. */
export function clientAdminRoutes({ db, now = () => new Date() }: AppDeps) {
  return new Hono<AppEnv>()
    .get("/export", async (c) => {
      const principal = c.get("principal");
      authorizeClientDelete(principal);
      const query = parseOrThrow(clientExportQuerySchema, c.req.query());
      c.header("cache-control", "private, no-store");
      return c.json(await exportClients(db, query.search, principal, now()));
    })
    .post("/import/preview", async (c) => {
      const principal = c.get("principal");
      authorizeClientDelete(principal);
      const input = parseOrThrow(clientImportPreviewInputSchema, await readJson(c));
      c.header("cache-control", "private, no-store");
      return c.json(await previewClientImport(db, input.csv, principal));
    })
    .post("/import", async (c) => {
      const principal = c.get("principal");
      authorizeClientDelete(principal);
      const input = parseOrThrow(clientImportInputSchema, await readJson(c));
      c.header("cache-control", "private, no-store");
      return c.json(await importClients(db, input, principal), 201);
    })
    .get("/", async (c) => {
      authorizeClientAccess(c.get("principal"));
      const query = parseOrThrow(clientListQuerySchema, c.req.query());
      return c.json(await listClients(db, query));
    })
    .get("/:id/controls", async (c) =>
      c.json(
        await getClientControls(db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      ),
    )
    .patch("/:id/controls", async (c) => {
      authorizeClientAccess(c.get("principal"));
      return c.json(
        await updateClientControls(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(clientControlsInputSchema, await readJson(c)),
          c.get("principal"),
        ),
      );
    })
    .get("/:id", async (c) => {
      authorizeClientAccess(c.get("principal"));
      const id = parseOrThrow(idSchema, c.req.param("id"));
      return c.json(await getClientDetail(db, id));
    })
    .patch("/:id", async (c) => {
      const principal = c.get("principal");
      authorizeClientAccess(principal);
      const id = parseOrThrow(idSchema, c.req.param("id"));
      const body = parseOrThrow(updateClientRequestSchema, await readJson(c));
      return c.json(await updateClient(db, id, body, principal));
    })
    .delete("/:id", async (c) => {
      const principal = c.get("principal");
      authorizeClientDelete(principal);
      const id = parseOrThrow(idSchema, c.req.param("id"));
      await deleteClient(db, id, principal, now());
      return c.json({ id, deleted: true });
    });
}
