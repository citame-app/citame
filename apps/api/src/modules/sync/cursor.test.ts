import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { clientProfile } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { mutation, pull, push, uuid } from "../../../test/sync";
import { compactSyncLog } from "./compact";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "sync" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("cursor safety under concurrent writers", () => {
  test("a follower that pulls while slow transactions commit never misses a change", async () => {
    const writers = 24;
    const created = new Set<string>();
    const seen = new Set<string>();
    let cursor = (await pull(t, owner)).nextCursor;
    let done = false;

    const follower = (async () => {
      const drain = async () => {
        for (;;) {
          const page = await pull(t, owner, { since: cursor, limit: 5 });
          for (const c of page.changes) if (c.entity === "client") seen.add(c.id);
          cursor = page.nextCursor;
          if (!page.hasMore) return;
        }
      };
      while (!done) {
        await drain();
        await sleep(3);
      }
      await drain();
    })();

    await Promise.all(
      Array.from({ length: writers }, (_, i) => {
        const id = uuid();
        created.add(id);
        // Mix of write paths: REST-level inserts with an artificial delay inside the
        // transaction (long-running writer), and sync pushes.
        if (i % 2 === 0) {
          return t.db.transaction(async (tx) => {
            await tx.insert(clientProfile).values({ id, name: `slow-${i}` });
            await tx.execute(sql`select pg_sleep(${(i % 4) * 0.02})`);
          });
        }
        return push(t, owner, [mutation("client.create", { id, name: `push-${i}` })]);
      }),
    );
    done = true;
    await follower;

    expect([...created].filter((id) => !seen.has(id))).toEqual([]);
  });

  test("cursors are monotonic and headSeq never goes backwards while writes continue", async () => {
    let lastHead = 0;
    let lastCursor = 0;
    const writes = Promise.all(
      Array.from({ length: 15 }, (_, i) => t.db.insert(clientProfile).values({ name: `w${i}` })),
    );
    for (let i = 0; i < 15; i++) {
      const page = await pull(t, owner, { since: lastCursor, limit: 3 });
      expect(page.nextCursor).toBeGreaterThanOrEqual(lastCursor);
      expect(page.headSeq).toBeGreaterThanOrEqual(lastHead);
      lastCursor = page.nextCursor;
      lastHead = page.headSeq;
    }
    await writes;
  });
});

describe("log compaction", () => {
  test("drops superseded entries older than the cutoff but keeps each row's latest, tombstones included", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "A" }).returning();
    const [gone] = await t.db.insert(clientProfile).values({ name: "B" }).returning();
    if (!row || !gone) throw new Error("insert failed");
    for (const name of ["A1", "A2", "A3"]) {
      await t.db.update(clientProfile).set({ name }).where(eq(clientProfile.id, row.id));
    }
    await t.db
      .update(clientProfile)
      .set({ deletedAt: new Date() })
      .where(eq(clientProfile.id, gone.id));
    const before = await pull(t, owner, { since: 0, limit: 500 });
    const rawBefore = Number(
      (await t.db.execute<{ n: string }>(sql`select count(*) n from sync_change`))[0]?.n,
    );

    const removed = await compactSyncLog(t.db, { olderThan: new Date(Date.now() + 60_000) });
    const rawAfter = Number(
      (await t.db.execute<{ n: string }>(sql`select count(*) n from sync_change`))[0]?.n,
    );
    expect(removed).toBeGreaterThan(0);
    expect(rawAfter).toBe(rawBefore - removed);

    // A client that never synced still converges to the same state, tombstone included.
    const after = await pull(t, owner, { since: 0, limit: 500 });
    const key = (c: { entity: string; id: string; op: string }) => `${c.entity}:${c.id}:${c.op}`;
    expect(after.changes.map(key).sort()).toEqual(before.changes.map(key).sort());
    expect(after.changes.find((c) => c.id === gone.id)?.op).toBe("delete");
    // The head is preserved, so cursors held by clients stay valid.
    expect(after.headSeq).toBe(before.headSeq);
  });

  test("does not touch entries newer than the cutoff", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "A" }).returning();
    if (!row) throw new Error("insert failed");
    await t.db.update(clientProfile).set({ name: "A1" }).where(eq(clientProfile.id, row.id));
    const removed = await compactSyncLog(t.db, { olderThan: new Date(Date.now() - 3_600_000) });
    expect(removed).toBe(0);
    void f;
  });
});
