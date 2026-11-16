import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { clientMerge, clientProfile, pgErrorCode, user } from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import { eq, sql } from "drizzle-orm";
import { clientIdentityIds, clientRoot } from "../../client-identity";
import type { Tx } from "../../tx";

let t: Awaited<ReturnType<typeof createTestDatabase>>;
let actorId: string;
beforeAll(async () => {
  t = await createTestDatabase("client_merge_constraints");
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  actorId = crypto.randomUUID();
  await t.db.insert(user).values({
    id: actorId,
    name: "Merge constraint operator",
    email: "constraints@merge.test",
    role: "owner",
  });
});
async function profile(name = "Synthetic walk-in") {
  const [row] = await t.db.insert(clientProfile).values({ name }).returning();
  if (!row) throw new Error("Missing profile");
  return row.id;
}
function receipt(sourceId: string, targetId: string) {
  return {
    sourceId,
    targetId,
    createdBy: actorId,
    idempotencyKey: crypto.randomUUID(),
    requestFingerprint: "a".repeat(64),
    reviewHash: "b".repeat(64),
  };
}
async function link(tx: Tx, sourceId: string, targetId: string) {
  await tx.insert(clientMerge).values(receipt(sourceId, targetId));
  await tx
    .update(clientProfile)
    .set({ mergedIntoId: targetId })
    .where(eq(clientProfile.id, sourceId));
}
async function constraint(action: () => Promise<unknown>) {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(pgErrorCode(failure)).toBe("23514");
}
test("raw identity pointers and unpaired receipts cannot commit", async () => {
  const source = await profile(),
    target = await profile();
  await constraint(() =>
    t.db.update(clientProfile).set({ mergedIntoId: target }).where(eq(clientProfile.id, source)),
  );
  await constraint(() =>
    t.db.transaction(async (tx) => {
      await tx.insert(clientMerge).values(receipt(source, target));
    }),
  );
  expect(await t.db.select().from(clientMerge)).toHaveLength(0);
  expect((await clientRoot(t.db, source)).id).toBe(source);
  await constraint(() =>
    t.db.insert(clientProfile).values({ name: "Unreviewed alias", mergedIntoId: target }),
  );
});
test("later root links preserve original pointers and immutable receipts", async () => {
  const a = await profile("A"),
    b = await profile("B"),
    c = await profile("C");
  await t.db.transaction((tx) => link(tx, a, b));
  await t.db.transaction((tx) => link(tx, b, c));
  expect(new Set(await clientIdentityIds(t.db, a))).toEqual(new Set([a, b, c]));
  expect((await clientRoot(t.db, a)).id).toBe(c);
  const [original] = await t.db.select().from(clientProfile).where(eq(clientProfile.id, a));
  expect(original?.mergedIntoId).toBe(b);
  await constraint(() =>
    t.db.update(clientProfile).set({ mergedIntoId: c }).where(eq(clientProfile.id, a)),
  );
  await constraint(() =>
    t.db.update(clientProfile).set({ mergedIntoId: null }).where(eq(clientProfile.id, a)),
  );
  await constraint(() => t.db.delete(clientMerge).where(eq(clientMerge.sourceId, a)));
  await constraint(() =>
    t.db.update(clientMerge).set({ targetId: c }).where(eq(clientMerge.sourceId, a)),
  );
  await constraint(() => t.db.transaction((tx) => link(tx, c, a)));
});
test("the twenty-profile bound applies to two complete identity groups", async () => {
  const target = await profile("Surviving root");
  for (let i = 0; i < 19; i++) {
    const source = await profile();
    await t.db.transaction((tx) => link(tx, source, target));
  }
  expect(await clientIdentityIds(t.db, target)).toHaveLength(20);
  const overflow = await profile();
  await constraint(() => t.db.transaction((tx) => link(tx, overflow, target)));
  expect((await clientRoot(t.db, overflow)).id).toBe(overflow);
});
test("opposite raw receipt-first merges serialize without a cycle or a deadlock", async () => {
  const a = await profile("A"),
    b = await profile("B");
  const outcomes = await Promise.allSettled([
    t.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='3s'`);
      await link(tx, a, b);
    }),
    t.db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='3s'`);
      await link(tx, b, a);
    }),
  ]);
  expect(outcomes.filter((row) => row.status === "fulfilled")).toHaveLength(1);
  const rejected = outcomes.find((row) => row.status === "rejected");
  expect(rejected?.status).toBe("rejected");
  if (rejected?.status === "rejected") await constraint(() => Promise.reject(rejected.reason));
  expect(new Set(await clientIdentityIds(t.db, a))).toEqual(new Set([a, b]));
  expect(await t.db.select().from(clientMerge)).toHaveLength(1);
}, 15000);
