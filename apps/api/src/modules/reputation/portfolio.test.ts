import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { pgErrorCode, portfolioPhoto, service, staffProfile } from "@sob/db";
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
let image: string;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "reputation_portfolio" });
  image = (
    await sharp({ create: { width: 1200, height: 700, channels: 3, background: "#a24c69" } })
      .jpeg()
      .withExif({ IFD0: { Copyright: "Private test metadata" } })
      .toBuffer()
  ).toString("base64");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "portfolio@test.invalid");
});
const call = (path: string, method = "GET", input?: unknown, who = owner) =>
  json(t.app, `/admin/portfolio${path}`, method, input, who.cookie);
async function draft(changes: Record<string, unknown> = {}) {
  const input = {
    idempotencyKey: crypto.randomUUID(),
    caption: "Finished style",
    alt: "A finished style viewed from behind",
    imageBase64: image,
    serviceId: f.haircutId,
    ...changes,
  };
  const response = await call("", "POST", input);
  expect(response.status, await response.clone().text()).toBe(201);
  return {
    input,
    photo: (await response.json()) as {
      id: string;
      version: number;
      status: string;
      width: number;
      height: number;
    },
  };
}
async function publish(photo: { id: string; version: number }) {
  const response = await call(`/${photo.id}/publish`, "POST", {
    version: photo.version,
    publicationConfirmed: true,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<{ id: string; version: number; status: string }>;
}
test("uploads are private, bounded metadata-free pixels until explicitly published", async () => {
  const { photo } = await draft();
  expect(photo).toMatchObject({ status: "draft", width: 1024, height: 597 });
  expect(await (await json(t.app, "/portfolio", "GET")).json()).toMatchObject({ photos: [] });
  expect((await json(t.app, `/portfolio/${photo.id}/image`, "GET")).status).toBe(404);
  const preview = await call(`/${photo.id}/image`);
  expect(preview.status).toBe(200);
  expect(preview.headers.get("content-type")).toBe("image/jpeg");
  expect(preview.headers.get("cache-control")).toContain("no-store");
  const metadata = await sharp(Buffer.from(await preview.arrayBuffer())).metadata();
  expect(metadata.exif).toBeUndefined();
  expect(
    (await call(`/${photo.id}/publish`, "POST", { version: 1, publicationConfirmed: false }))
      .status,
  ).toBe(400);
  const published = await publish(photo);
  expect(published.status).toBe("published");
  await t.db.update(service).set({ name: "Changed treatment" }).where(eq(service.id, f.haircutId));
  const listing = await json(t.app, `/portfolio?serviceId=${f.haircutId}`, "GET");
  expect(await listing.json()).toMatchObject({
    photos: [
      {
        id: photo.id,
        caption: "Finished style",
        alt: "A finished style viewed from behind",
        serviceName: "Haircut",
      },
    ],
  });
  expect((await json(t.app, `/portfolio/${photo.id}/image`, "GET")).status).toBe(200);
});
test("retries recover one draft, versioned edits withdraw old publication and deletion erases the pixels", async () => {
  const { photo, input } = await draft();
  expect(await (await call("", "POST", input)).json()).toMatchObject({ id: photo.id, version: 1 });
  expect((await call("", "POST", { ...input, caption: "Other" })).status).toBe(409);
  const published = await publish(photo);
  expect(
    (
      await call(`/${photo.id}`, "PUT", {
        version: 1,
        caption: "Stale",
        alt: "Stale",
        serviceId: null,
      })
    ).status,
  ).toBe(409);
  const edit = await call(`/${photo.id}`, "PUT", {
    version: published.version,
    caption: "Corrected caption",
    alt: "Corrected image description",
    serviceId: null,
  });
  expect(edit.status).toBe(200);
  expect(await edit.json()).toMatchObject({
    version: 3,
    status: "draft",
    serviceId: null,
    serviceName: null,
  });
  expect((await json(t.app, `/portfolio/${photo.id}/image`, "GET")).status).toBe(404);
  const republished = await publish({ ...photo, version: 3 });
  const hidden = await call(`/${photo.id}/unpublish`, "POST", { version: republished.version });
  expect(hidden.status).toBe(200);
  expect((await json(t.app, `/portfolio/${photo.id}/image`, "GET")).status).toBe(404);
  expect(
    (await call(`/${photo.id}/remove`, "POST", { version: 5, confirmation: false })).status,
  ).toBe(400);
  expect(
    (await call(`/${photo.id}/remove`, "POST", { version: 5, confirmation: true })).status,
  ).toBe(200);
  expect((await call(`/${photo.id}/image`)).status).toBe(404);
  expect((await call("", "POST", input)).status).toBe(409);
  expect(
    (await call(`/${photo.id}/publish`, "POST", { version: 6, publicationConfirmed: true })).status,
  ).toBe(404);
});
test("clients and ordinary professionals cannot administer or preview drafts; unsafe files never become drafts", async () => {
  const { photo } = await draft();
  for (const role of ["client", "staff"] as const) {
    const who = await actor(t, role, `${role}@portfolio.test`);
    expect((await call("", "GET", undefined, who)).status).toBe(403);
    expect((await call(`/${photo.id}/image`, "GET", undefined, who)).status).toBe(403);
    expect(
      (await call(`/${photo.id}/publish`, "POST", { version: 1, publicationConfirmed: true }, who))
        .status,
    ).toBe(403);
  }
  expect(
    (
      await call("", "POST", {
        idempotencyKey: crypto.randomUUID(),
        caption: "SVG",
        alt: "Unsafe vector",
        imageBase64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64"),
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await call("", "POST", {
        idempotencyKey: crypto.randomUUID(),
        caption: "Private pointer",
        alt: "A picture",
        imageBase64: image,
        clientPhotoId: crypto.randomUUID(),
      })
    ).status,
  ).toBe(400);
  expect((await json(t.app, "/portfolio?limit=1000", "GET")).status).toBe(400);
});

test("concurrent retries reserve one bounded image and erasure cannot be undone through the database or old upload", async () => {
  const first = await draft();
  const retries = await Promise.all([call("", "POST", first.input), call("", "POST", first.input)]);
  expect(retries.map((response) => response.status)).toEqual([201, 201]);
  const [stored] = await t.db
    .select()
    .from(portfolioPhoto)
    .where(eq(portfolioPhoto.id, first.photo.id));
  if (!stored) throw new Error("Missing stored image");
  await t.db.insert(portfolioPhoto).values(
    Array.from({ length: 199 }, () => ({
      ...stored,
      id: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
    })),
  );
  expect(
    (await call("", "POST", { ...first.input, idempotencyKey: crypto.randomUUID() })).status,
  ).toBe(409);
  expect(
    (await call(`/${first.photo.id}/remove`, "POST", { version: 1, confirmation: true })).status,
  ).toBe(200);
  const [removed] = await t.db
    .select()
    .from(portfolioPhoto)
    .where(eq(portfolioPhoto.id, first.photo.id));
  expect(removed).toMatchObject({
    image: null,
    caption: null,
    alt: null,
    serviceId: null,
    serviceName: null,
  });
  let rejected = false;
  try {
    await t.db
      .update(portfolioPhoto)
      .set({ image: stored.image, caption: stored.caption, alt: stored.alt, deletedAt: null })
      .where(eq(portfolioPhoto.id, stored.id));
  } catch (error) {
    rejected = true;
    expect(pgErrorCode(error)).toBe("23514");
  }
  expect(rejected).toBe(true);
  await draft();
  const manager = await actor(t, "staff", "manager@portfolio.test");
  if (!manager.staffId) throw new Error("Missing staff");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, manager.staffId));
  expect((await call("", "GET", undefined, manager)).status).toBe(200);
});

test("new drafts cannot link an inactive treatment but existing snapshots remain editable without rewriting their names", async () => {
  const { photo } = await draft();
  await t.db
    .update(service)
    .set({ active: false, name: "Changed inactive catalog" })
    .where(eq(service.id, f.haircutId));
  const input = {
    idempotencyKey: crypto.randomUUID(),
    caption: "Other work",
    alt: "Synthetic pixels",
    imageBase64: image,
    serviceId: f.haircutId,
  };
  expect((await call("", "POST", input)).status).toBe(400);
  const edited = await call(`/${photo.id}`, "PUT", {
    version: 1,
    caption: "Corrected caption",
    alt: "Synthetic pixels",
    serviceId: f.haircutId,
  });
  expect(edited.status).toBe(200);
  expect(await edited.json()).toMatchObject({ serviceName: "Haircut" });
});
