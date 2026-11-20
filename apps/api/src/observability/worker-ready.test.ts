import { expect, test } from "bun:test";
import { createDb } from "@sob/db";
import { createTestDatabase } from "@sob/db/testing";
import { sql } from "drizzle-orm";
import { startWorkerReadiness } from "./worker-ready";

test("worker readiness is private and fails when its database is unavailable", async () => {
  const data = await createTestDatabase("worker_readiness");
  const workerDb = createDb(data.url);
  const listener = startWorkerReadiness(workerDb.db, 0);
  try {
    expect(listener.hostname).toBe("127.0.0.1");
    const url = new URL("/ready", listener.url);
    expect((await fetch(url)).status).toBe(204);
    expect((await fetch(new URL("/unknown", url))).status).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
    await workerDb.close();
    const unavailable = await fetch(url);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toBe("");
  } finally {
    await listener.stop(true);
    await data.close();
    await workerDb.close();
  }
});

test("worker readiness rejects a role that can connect but cannot update queues", async () => {
  const data = await createTestDatabase("worker_readiness");
  const role = sql.identifier(`worker_readonly_${Bun.randomUUIDv7().replaceAll("-", "")}`);
  const rollback = new Error("Roll back the temporary role");
  try {
    await expect(
      data.db.transaction(async (tx) => {
        await tx.execute(sql`create role ${role}`);
        await tx.execute(sql`grant usage on schema public to ${role}`);
        await tx.execute(sql`grant select on all tables in schema public to ${role}`);
        await tx.execute(sql`set local role ${role}`);
        const listener = startWorkerReadiness(tx, 0);
        try {
          expect(await tx.execute(sql`select 1`)).toHaveLength(1);
          expect((await fetch(new URL("/ready", listener.url))).status).toBe(503);
        } finally {
          await listener.stop(true);
        }
        throw rollback;
      }),
    ).rejects.toBe(rollback);
  } finally {
    await data.close();
  }
});
