import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { clientPhotoSchema, clientPhotosSchema } from "@sob/contracts";
import { auditLog, clientPhoto, clientProfile } from "@sob/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let image: Buffer;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "client_photos" });
  image = await sharp({ create: { width: 1600, height: 800, channels: 3, background: "#a24c69" } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .withExif({
      IFD0: { Copyright: "Private test image" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "51/1 30/1 0/1" },
    })
    .toBuffer();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@photos.test");
});
const call = (path: string, method = "GET", input?: unknown, who = owner, clientId = f.clientId) =>
  json(t.app, `/admin/clients/${clientId}/photos${path}`, method, input, who.cookie);
const uploadInput = () => ({
  caption: "Before colour",
  capturedOn: "2026-03-01",
  permissionConfirmed: true,
  idempotencyKey: crypto.randomUUID(),
  imageBase64: image.toString("base64"),
});
async function upload(input = uploadInput()) {
  const response = await call("", "POST", input);
  expect(response.status, await response.clone().text()).toBe(201);
  return clientPhotoSchema.parse(await response.json());
}
test("stores a normalized private photo with corrected orientation and no location/EXIF data", async () => {
  const photo = await upload();
  expect(photo).toMatchObject({
    caption: "Before colour",
    capturedOn: "2026-03-01",
    width: 512,
    height: 1024,
    version: 1,
  });
  const list = clientPhotosSchema.parse(await (await call("")).json());
  expect(list.photos).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain("imageBase64");
  const response = await call(`/${photo.id}/image`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/jpeg");
  expect(response.headers.get("cache-control")).toContain("no-store");
  const output = Buffer.from(await response.arrayBuffer());
  expect(output.byteLength).toBe(photo.bytes);
  const metadata = await sharp(output).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(metadata.xmp).toBeUndefined();
  expect(metadata.orientation).toBeUndefined();
  expect(output.includes(Buffer.from("Private test image"))).toBe(false);
  const audit = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "client.photo_uploaded"));
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain("Before colour");
});

test("concurrent upload retries create one image and cannot reuse the identifier for changed data", async () => {
  const input = uploadInput();
  const responses = await Promise.all([call("", "POST", input), call("", "POST", input)]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const photos = await Promise.all(
    responses.map(async (r) => clientPhotoSchema.parse(await r.json())),
  );
  expect(photos[1]).toEqual(photos[0]);
  expect((await call("", "POST", { ...input, caption: "A different request" })).status).toBe(409);
  expect(clientPhotosSchema.parse(await (await call("")).json()).photos).toHaveLength(1);
});

test("private image reads and writes require a current team permission and the correct client", async () => {
  const photo = await upload();
  const customer = await actor(t, "client", "customer@photos.test");
  const professional = await actor(t, "staff", "professional@photos.test");
  expect(
    (await json(t.app, `/admin/clients/${f.clientId}/photos/${photo.id}/image`, "GET")).status,
  ).toBe(401);
  expect((await call(`/${photo.id}/image`, "GET", undefined, customer)).status).toBe(403);
  expect((await call("", "POST", uploadInput(), customer)).status).toBe(403);
  expect((await call(`/${photo.id}/image`, "GET", undefined, professional)).status).toBe(200);
  const [other] = await t.db.insert(clientProfile).values({ name: "Other client" }).returning();
  if (!other) throw new Error("Missing fixture");
  expect((await call(`/${photo.id}/image`, "GET", undefined, owner, other.id)).status).toBe(404);
  expect(
    (
      await call(
        `/${photo.id}`,
        "PATCH",
        { version: 1, caption: "Changed", capturedOn: null },
        owner,
        other.id,
      )
    ).status,
  ).toBe(404);
});

test("unconfirmed, malformed, vector and excessively large-pixel uploads cannot create images", async () => {
  const vector = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>',
  ).toString("base64");
  const huge = await sharp({
    create: { width: 5000, height: 5000, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  for (const changes of [
    { permissionConfirmed: false },
    { imageBase64: "not base64" },
    { imageBase64: vector },
    { imageBase64: Buffer.from("not an image").toString("base64") },
    { imageBase64: huge.toString("base64") },
  ]) {
    expect((await call("", "POST", { ...uploadInput(), ...changes })).status).toBe(400);
  }
  expect(clientPhotosSchema.parse(await (await call("")).json()).photos).toHaveLength(0);
});

test("caption edits are revision-fenced and removal is retry-safe without retaining the image", async () => {
  const input = uploadInput();
  const photo = await upload(input);
  const patch = { version: 1, caption: "After colour", capturedOn: "2026-03-02" };
  expect((await call(`/${photo.id}`, "PATCH", patch)).status).toBe(200);
  expect((await call(`/${photo.id}`, "PATCH", { ...patch, caption: "Stale" })).status).toBe(409);
  expect((await call(`/${photo.id}?version=1`, "DELETE")).status).toBe(409);
  expect((await call(`/${photo.id}?version=2`, "DELETE")).status).toBe(200);
  expect((await call(`/${photo.id}?version=2`, "DELETE")).status).toBe(200);
  expect((await call(`/${photo.id}/image`)).status).toBe(404);
  expect(
    (
      await t.db
        .select({
          image: clientPhoto.image,
          caption: clientPhoto.caption,
          capturedOn: clientPhoto.capturedOn,
        })
        .from(clientPhoto)
        .where(eq(clientPhoto.id, photo.id))
    )[0],
  ).toMatchObject({ image: null, capturedOn: null });
  expect(
    (
      await t.db
        .select({ caption: clientPhoto.caption })
        .from(clientPhoto)
        .where(eq(clientPhoto.id, photo.id))
    )[0]?.caption,
  ).not.toBe("After colour");
  expect(clientPhotosSchema.parse(await (await call("")).json()).photos).toHaveLength(0);
  expect((await call("", "POST", input)).status).toBe(409);
});

test("a concurrent last-slot upload respects the profile limit and deletion releases capacity", async () => {
  const first = await upload();
  const [row] = await t.db.select().from(clientPhoto).where(eq(clientPhoto.id, first.id));
  if (!row) throw new Error("Missing photo fixture");
  await t.db.insert(clientPhoto).values(
    Array.from({ length: 18 }, () => ({
      ...row,
      id: Bun.randomUUIDv7(),
      idempotencyKey: crypto.randomUUID(),
    })),
  );
  const responses = await Promise.all([
    call("", "POST", uploadInput()),
    call("", "POST", uploadInput()),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const limited = responses.find((response) => response.status === 409);
  expect(limited ? await limited.json() : null).toMatchObject({ error: { code: "storage_limit" } });
  expect(clientPhotosSchema.parse(await (await call("")).json()).photos).toHaveLength(20);
  expect((await call(`/${first.id}?version=1`, "DELETE")).status).toBe(200);
  expect((await call("", "POST", uploadInput())).status).toBe(201);
});

test("the salon quota bounds total private image storage across clients", async () => {
  const first = await upload();
  const [row] = await t.db.select().from(clientPhoto).where(eq(clientPhoto.id, first.id));
  if (!row) throw new Error("Missing photo fixture");
  const profiles = await t.db
    .insert(clientProfile)
    .values(Array.from({ length: 100 }, (_, i) => ({ name: `Photo quota fixture ${i}` })))
    .returning({ id: clientProfile.id });
  const copies = profiles.flatMap((profile, index) =>
    Array.from({ length: index === 0 ? 19 : 20 }, () => ({
      ...row,
      id: Bun.randomUUIDv7(),
      clientId: profile.id,
      idempotencyKey: crypto.randomUUID(),
    })),
  );
  await t.db.insert(clientPhoto).values(copies);
  const limited = await call("", "POST", uploadInput());
  expect(limited.status).toBe(409);
  expect(await limited.json()).toMatchObject({ error: { code: "storage_limit" } });
  expect((await call(`/${first.id}?version=1`, "DELETE")).status).toBe(200);
  expect((await call("", "POST", uploadInput())).status).toBe(201);
});
