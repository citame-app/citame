import {
  type AdminClient,
  clientControlsInputSchema,
  clientExportQuerySchema,
  clientImportInputSchema,
  clientImportPreviewInputSchema,
  clientListQuerySchema,
  clientMergeInputSchema,
  clientMergePairSchema,
  clientPhotoDeleteQuerySchema,
  clientPhotoUpdateSchema,
  clientPhotoUploadSchema,
  createClientRequestSchema,
  idSchema,
  updateClientRequestSchema,
} from "@sob/contracts";
import { Hono } from "hono";
import type { AppDeps } from "../../app";
import { authorizeClientAccess, authorizeClientDelete } from "../../auth/policy";
import type { AppEnv } from "../../auth/principal";
import { parseOrThrow, readJson } from "../../http";
import {
  clientGroups,
  createClient,
  deleteClient,
  getClientDetail,
  listClients,
  updateClient,
} from "./admin";
import { getClientControls, updateClientControls } from "./controls";
import { clientDuplicates } from "./duplicates";
import { mergeClients, previewClientMerge } from "./merge";
import {
  deleteClientPhoto,
  listClientPhotos,
  readClientPhotoImage,
  updateClientPhoto,
  uploadClientPhoto,
} from "./photos";
import { exportClients, importClients, previewClientImport } from "./transfer";

/** Client directory, mounted at `/admin/clients` behind `requireAuth`. */
export function clientAdminRoutes({ db, now = () => new Date(), booksyConsultation }: AppDeps) {
  const sourceGroups = new Map<string, { clientId: string; startsAt: string }>();
  for (const a of booksyConsultation?.appointments ?? []) {
    const key = a.sourceCopy?.groupRef ?? a.id;
    const old = sourceGroups.get(key);
    if (!old || a.startsAt < old.startsAt)
      sourceGroups.set(key, { clientId: a.clientId, startsAt: a.startsAt });
  }
  const sourceStats = new Map<string, { count: number; last: string }>();
  for (const g of sourceGroups.values()) {
    const old = sourceStats.get(g.clientId);
    sourceStats.set(g.clientId, {
      count: (old?.count ?? 0) + 1,
      last: old && old.last > g.startsAt ? old.last : g.startsAt,
    });
  }
  const withSourceStats = (client: AdminClient): AdminClient => {
    const source = sourceStats.get(client.id);
    return source
      ? {
          ...client,
          appointmentCount: client.appointmentCount + source.count,
          lastVisitAt:
            client.lastVisitAt && client.lastVisitAt > source.last
              ? client.lastVisitAt
              : source.last,
        }
      : client;
  };
  return new Hono<AppEnv>()
    .post("/merge/preview", async (c) =>
      c.json(
        await previewClientMerge(
          db,
          parseOrThrow(clientMergePairSchema, await readJson(c)),
          c.get("principal"),
        ),
      ),
    )
    .post("/merge", async (c) =>
      c.json(
        await mergeClients(
          db,
          parseOrThrow(clientMergeInputSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
        201,
      ),
    )
    .get("/groups", async (c) => {
      authorizeClientAccess(c.get("principal"));
      return c.json(await clientGroups(db));
    })
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
    .post("/", async (c) =>
      c.json(
        await createClient(
          db,
          parseOrThrow(createClientRequestSchema, await readJson(c)),
          c.get("principal"),
        ),
        201,
      ),
    )
    .get("/", async (c) => {
      authorizeClientAccess(c.get("principal"));
      const query = parseOrThrow(clientListQuerySchema, c.req.query());
      const sortedCopy = booksyConsultation && query.sort === "lastVisitAt";
      const data = await listClients(
        db,
        sortedCopy
          ? {
              ...query,
              page: 1,
              pageSize: booksyConsultation.base.clients.length + 100,
              sort: "name",
            }
          : query,
      );
      let clients = data.clients.map(withSourceStats);
      if (sortedCopy) {
        clients.sort((a, b) => {
          if (!a.lastVisitAt || !b.lastVisitAt)
            return a.lastVisitAt ? -1 : b.lastVisitAt ? 1 : a.name.localeCompare(b.name);
          const n = Date.parse(a.lastVisitAt) - Date.parse(b.lastVisitAt);
          return (query.order === "asc" ? n : -n) || a.name.localeCompare(b.name);
        });
        clients = clients.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
      }
      return c.json({ ...data, page: query.page, pageSize: query.pageSize, clients });
    })
    .get("/:id/duplicates", async (c) => {
      c.header("cache-control", "private, no-store");
      return c.json(
        await clientDuplicates(db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      );
    })
    .get("/:id/photos", async (c) => {
      c.header("cache-control", "private, no-store");
      return c.json(
        await listClientPhotos(db, parseOrThrow(idSchema, c.req.param("id")), c.get("principal")),
      );
    })
    .post("/:id/photos", async (c) => {
      const principal = c.get("principal");
      const input = parseOrThrow(clientPhotoUploadSchema, await readJson(c));
      c.header("cache-control", "private, no-store");
      return c.json(
        await uploadClientPhoto(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          input,
          principal,
          now(),
        ),
        201,
      );
    })
    .patch("/:id/photos/:photoId", async (c) => {
      c.header("cache-control", "private, no-store");
      return c.json(
        await updateClientPhoto(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(idSchema, c.req.param("photoId")),
          parseOrThrow(clientPhotoUpdateSchema, await readJson(c)),
          c.get("principal"),
          now(),
        ),
      );
    })
    .delete("/:id/photos/:photoId", async (c) =>
      c.json(
        await deleteClientPhoto(
          db,
          parseOrThrow(idSchema, c.req.param("id")),
          parseOrThrow(idSchema, c.req.param("photoId")),
          parseOrThrow(clientPhotoDeleteQuerySchema, c.req.query()).version,
          c.get("principal"),
          now(),
        ),
      ),
    )
    .get("/:id/photos/:photoId/image", async (c) => {
      const image = await readClientPhotoImage(
        db,
        parseOrThrow(idSchema, c.req.param("id")),
        parseOrThrow(idSchema, c.req.param("photoId")),
        c.get("principal"),
      );
      return c.body(Buffer.from(image), 200, {
        "content-type": "image/jpeg",
        "cache-control": "private, no-store",
        "content-disposition": 'inline; filename="client-photo.jpg"',
      });
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
      const detail = await getClientDetail(db, id);
      return c.json({
        ...detail,
        client: withSourceStats(detail.client),
        appointments: [
          ...detail.appointments,
          ...(booksyConsultation?.appointments.filter((a) => a.clientId === id) ?? []),
        ].sort((a, b) => b.startsAt.localeCompare(a.startsAt)),
      });
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
