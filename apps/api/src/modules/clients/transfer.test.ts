import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  clientExportSchema,
  clientImportPreviewSchema,
  clientImportResultSchema,
} from "@sob/contracts";
import { auditLog, clientProfile, staffProfile } from "@sob/db";
import { eq } from "drizzle-orm";
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
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "client_transfer" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@transfer.test");
});
const call = (path: string, method = "GET", input?: unknown, who = owner) =>
  json(t.app, `/admin/clients${path}`, method, input, who.cookie);
const csv =
  "name,email,phone,notes,tags\nNora,nora@transfer.test,+34600111222,Private note,vip;colour\nInvalid,not-an-email,,Hidden,";
async function preview(value = csv) {
  const response = await call("/import/preview", "POST", { csv: value });
  expect(response.status, await response.clone().text()).toBe(200);
  return clientImportPreviewSchema.parse(await response.json());
}
test("previews validated rows without writing and imports only explicitly selected clean rows", async () => {
  const before = await t.db.select().from(clientProfile);
  const plan = await preview();
  expect(plan.counts).toEqual({ create: 1, duplicate: 0, invalid: 1, ambiguous: 0 });
  expect(await t.db.select().from(clientProfile)).toHaveLength(before.length);
  const rejected = await call("/import", "POST", {
    csv,
    reviewHash: plan.reviewHash,
    idempotencyKey: crypto.randomUUID(),
    rows: [2, 3],
  });
  expect(rejected.status).toBe(400);
  expect(await t.db.select().from(clientProfile)).toHaveLength(before.length);
  const response = await call("/import", "POST", {
    csv,
    reviewHash: plan.reviewHash,
    idempotencyKey: crypto.randomUUID(),
    rows: [2],
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const result = clientImportResultSchema.parse(await response.json());
  expect(result).toMatchObject({ created: 1, skipped: 1 });
  expect(
    await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.id, result.clientIds[0] ?? "00000000-0000-4000-8000-000000000000")),
  ).toMatchObject([
    {
      name: "Nora",
      email: "nora@transfer.test",
      tags: ["vip", "colour"],
      userId: null,
      bookingAccess: "normal",
    },
  ]);
  const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, "client.import"));
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain("Private note");
  expect(JSON.stringify(audit)).not.toContain("nora@transfer.test");
});

test("normalized contacts identify duplicates, ambiguous identities and repeated file rows without merging", async () => {
  await t.db
    .update(clientProfile)
    .set({ email: "existing@transfer.test", phone: "+34 600 111 222" })
    .where(eq(clientProfile.id, f.clientId));
  const [other] = await t.db
    .insert(clientProfile)
    .values({ name: "Other person", phone: "+34600999888" })
    .returning();
  if (!other) throw new Error("Missing fixture client");
  const plan = await preview(
    "name,email,phone\nSame, EXISTING@TRANSFER.TEST ,\nAmbiguous,existing@transfer.test,+34600999888\nNew,,+34600777888\nRepeated,,+34 600 777 888",
  );
  expect(plan.rows.map((r) => r.status)).toEqual(["duplicate", "ambiguous", "create", "duplicate"]);
  expect(plan.rows[1]?.matches.map((m) => m.id).sort()).toEqual([f.clientId, other.id].sort());
  expect(plan.rows[3]?.duplicateRow).toBe(4);
  expect(
    (await t.db.select().from(clientProfile).where(eq(clientProfile.id, f.clientId)))[0]?.name,
  ).not.toBe("Same");
});

test("a changed directory invalidates the review and concurrent imports cannot create duplicate contacts", async () => {
  const source = "name,email\nConcurrent,concurrent@transfer.test";
  const plan = await preview(source);
  const request = { csv: source, reviewHash: plan.reviewHash, rows: [2] };
  const responses = await Promise.all([
    call("/import", "POST", { ...request, idempotencyKey: crypto.randomUUID() }),
    call("/import", "POST", { ...request, idempotencyKey: crypto.randomUUID() }),
  ]);
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(
    await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.email, "concurrent@transfer.test")),
  ).toHaveLength(1);
});

test("an unknown response can replay one committed import despite its now-stale preview", async () => {
  const plan = await preview();
  const request = {
    csv,
    reviewHash: plan.reviewHash,
    idempotencyKey: crypto.randomUUID(),
    rows: [2],
  };
  const responses = await Promise.all([
    call("/import", "POST", request),
    call("/import", "POST", request),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const results = await Promise.all(
    responses.map(async (r) => clientImportResultSchema.parse(await r.json())),
  );
  expect(results[1]).toEqual(results[0]);
  expect(
    (await call("/import", "POST", { ...request, csv: csv.replace("Nora", "Someone else") }))
      .status,
  ).toBe(409);
});

test("bulk contact transfer requires owner or manager privileges", async () => {
  for (const role of ["staff", "client"] as const) {
    const who = await actor(t, role, `${role}@transfer.test`);
    expect((await call("/export", "GET", undefined, who)).status).toBe(403);
    expect((await call("/import/preview", "POST", { csv }, who)).status).toBe(403);
    expect((await call("/import", "POST", { csv }, who)).status).toBe(403);
  }
});

test("exports the complete searched directory with private-cache controls and spreadsheet protection", async () => {
  await t.db
    .update(clientProfile)
    .set({ name: '=HYPERLINK("bad")', notes: "Private note", tags: ["vip"], phone: "+34600111222" })
    .where(eq(clientProfile.id, f.clientId));
  await t.db.insert(clientProfile).values({ name: "Deleted client", deletedAt: new Date() });
  const response = await call("/export?search=HYPERLINK");
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  const result = clientExportSchema.parse(await response.json());
  expect(result.count).toBe(1);
  expect(result.csv).toContain("'=HYPERLINK");
  expect(result.csv).toContain("Private note");
  expect(result.csv).not.toContain("Deleted client");
});

test("manager access is evaluated from the current staff profile", async () => {
  const manager = await actor(t, "staff", "manager@transfer.test", { staffProfileId: f.anaId });
  expect((await call("/export", "GET", undefined, manager)).status).toBe(403);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, f.anaId));
  expect((await call("/export", "GET", undefined, manager)).status).toBe(200);
  const response = await call("/import/preview", "POST", { csv }, manager);
  expect(response.status).toBe(200);
  const plan = clientImportPreviewSchema.parse(await response.json());
  expect(
    (
      await call(
        "/import",
        "POST",
        { csv, reviewHash: plan.reviewHash, idempotencyKey: crypto.randomUUID(), rows: [2] },
        manager,
      )
    ).status,
  ).toBe(201);
});

test("an export beyond the batch limit fails instead of silently truncating the directory", async () => {
  await t.db
    .insert(clientProfile)
    .values(Array.from({ length: 5001 }, (_, index) => ({ name: `Limit fixture ${index}` })));
  const response = await call("/export?search=Limit%20fixture");
  expect(response.status).toBe(400);
  expect(await response.text()).toContain("5000");
});

test("an offline-created client between preview and commit is detected before import writes", async () => {
  const source = "name,email\nOffline client,offline@transfer.test";
  const plan = await preview(source);
  await t.db
    .insert(clientProfile)
    .values({ name: "Already saved offline", email: "offline@transfer.test" });
  const response = await call("/import", "POST", {
    csv: source,
    rows: [2],
    reviewHash: plan.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(response.status).toBe(409);
  expect(
    await t.db.select().from(clientProfile).where(eq(clientProfile.email, "offline@transfer.test")),
  ).toHaveLength(1);
});
