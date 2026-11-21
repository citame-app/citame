import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  appointment,
  appointmentService,
  clientProfile,
  salonSettings,
  service,
  staffProfile,
} from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

let t: TestDatabase;

beforeAll(async () => {
  t = await createTestDatabase("dbsync");
});

afterAll(async () => {
  await t.close();
});

beforeEach(async () => {
  await t.reset();
});

interface ChangeRow {
  seq: number;
  entity: string;
  row_id: string;
  op: string;
}

async function changes(): Promise<ChangeRow[]> {
  const rows = await t.db.execute<{ seq: string; entity: string; row_id: string; op: string }>(
    sql`select seq, entity, row_id, op from sync_change order by seq`,
  );
  return rows.map((r) => ({ seq: Number(r.seq), entity: r.entity, row_id: r.row_id, op: r.op }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("sync_change recording (database triggers)", () => {
  test("an insert records an upsert with the entity name and the row id", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "Lucia" }).returning();
    expect(await changes()).toEqual([
      { seq: expect.any(Number), entity: "client", row_id: row?.id ?? "", op: "upsert" },
    ]);
  });

  test("updates are upserts, a soft delete is a tombstone, a hard delete is a tombstone", async () => {
    const [row] = await t.db.insert(clientProfile).values({ name: "Lucia" }).returning();
    if (!row) throw new Error("insert failed");
    await t.db.execute(sql`update client_profile set name = 'Lu' where id = ${row.id}`);
    await t.db.execute(sql`update client_profile set deleted_at = now() where id = ${row.id}`);
    const recorded = await changes();
    expect(recorded.filter((c) => c.entity === "client").map((c) => [c.row_id, c.op])).toEqual([
      [row.id, "upsert"],
      [row.id, "upsert"],
      [row.id, "delete"],
    ]);
    expect(recorded.filter((c) => c.entity !== "client")).toEqual([
      { seq: expect.any(Number), entity: "live_view", row_id: "intake_records", op: "upsert" },
    ]);
    await t.db.execute(sql`delete from client_profile where id = ${row.id}`);
    expect(await changes()).toEqual([
      ...recorded,
      { seq: expect.any(Number), entity: "client", row_id: row.id, op: "delete" },
    ]);
  });

  test("a rolled back transaction records nothing", async () => {
    await t.db
      .transaction(async (tx) => {
        await tx.insert(clientProfile).values({ name: "Ghost" });
        throw new Error("boom");
      })
      .catch(() => {});
    expect(await changes()).toEqual([]);
  });

  test("every synced entity is recorded under its public name", async () => {
    const [svc] = await t.db
      .insert(service)
      .values({ name: "Cut", durationMinutes: 30, priceCents: 1 })
      .returning();
    const [staff] = await t.db.insert(staffProfile).values({ displayName: "Ana" }).returning();
    if (!svc || !staff) throw new Error("insert failed");
    await t.db.execute(
      sql`insert into service_staff (id, service_id, staff_id) values (${Bun.randomUUIDv7()}, ${svc.id}, ${staff.id})`,
    );
    await t.db.execute(
      sql`insert into working_hours (id, staff_id, weekday, start_time, end_time)
          values (${Bun.randomUUIDv7()}, ${staff.id}, 1, '09:00', '17:00')`,
    );
    await t.db.execute(
      sql`insert into time_off (id, staff_id, starts_at, ends_at)
          values (${Bun.randomUUIDv7()}, ${staff.id}, now(), now() + interval '1 day')`,
    );
    await t.db.insert(salonSettings).values({ name: "S", timezone: "UTC" });
    const entities = (await changes()).map((c) => c.entity);
    expect(entities).toEqual([
      "service",
      "staff",
      "service_staff",
      "working_hours",
      "time_off",
      "salon_settings",
    ]);
    expect((await changes()).at(-1)?.row_id).toBe("1");
  });

  test("snapshot rows of an appointment re-announce the parent appointment", async () => {
    const [staff] = await t.db.insert(staffProfile).values({ displayName: "Ana" }).returning();
    const [client] = await t.db.insert(clientProfile).values({ name: "Lucia" }).returning();
    if (!staff || !client) throw new Error("insert failed");
    const [appt] = await t.db
      .insert(appointment)
      .values({
        staffId: staff.id,
        clientId: client.id,
        startsAt: new Date("2026-03-09T12:00:00Z"),
        endsAt: new Date("2026-03-09T13:00:00Z"),
      })
      .returning();
    if (!appt) throw new Error("insert failed");
    await t.db.insert(appointmentService).values({
      appointmentId: appt.id,
      position: 0,
      name: "Cut",
      durationMinutes: 30,
      bufferMinutes: 0,
      priceCents: 1,
      currency: "ARS",
    });
    const all = await changes();
    expect(all.at(-1)).toMatchObject({ entity: "appointment", row_id: appt.id, op: "upsert" });
  });

  test("seq is assigned in commit order, not in statement order", async () => {
    let releaseFirst: () => void = () => {};
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstWrote: () => void = () => {};
    const firstHasWritten = new Promise<void>((resolve) => {
      firstWrote = resolve;
    });

    // T1 writes first but commits last; T2 writes second and commits first.
    const first = t.db.transaction(async (tx) => {
      await tx.insert(clientProfile).values({ id: Bun.randomUUIDv7(), name: "first" });
      firstWrote();
      await firstMayCommit;
    });
    await firstHasWritten;
    await t.db.insert(clientProfile).values({ id: Bun.randomUUIDv7(), name: "second" });
    releaseFirst();
    await first;

    const named = await t.db.execute<{ seq: string; name: string }>(
      sql`select c.seq, p.name from sync_change c join client_profile p on p.id::text = c.row_id order by c.seq`,
    );
    expect(named.map((r) => r.name)).toEqual(["second", "first"]);
  });

  test("a concurrent reader never skips a committed change (no seq gaps behind the cursor)", async () => {
    const writers = 40;
    const seen = new Set<number>();
    let cursor = 0;
    let done = false;

    const reader = (async () => {
      const drain = async () => {
        const rows = await t.db.execute<{ seq: string }>(
          sql`select seq from sync_change where seq > ${cursor} order by seq`,
        );
        for (const row of rows) {
          seen.add(Number(row.seq));
          cursor = Number(row.seq);
        }
      };
      while (!done) {
        await drain();
        await sleep(2);
      }
      await drain();
    })();

    await Promise.all(
      Array.from({ length: writers }, (_, i) =>
        t.db.transaction(async (tx) => {
          await tx.insert(clientProfile).values({ name: `c${i}` });
          await tx.execute(sql`select pg_sleep(${(i % 5) * 0.01})`);
          await tx.insert(clientProfile).values({ name: `d${i}` });
        }),
      ),
    );
    done = true;
    await reader;

    const all = (await changes()).map((c) => c.seq);
    expect(all.length).toBe(writers * 2);
    expect([...seen].sort((a, b) => a - b)).toEqual(all);
  });

  test("control: a naive immediate sequence log DOES skip rows (the hazard the triggers avoid)", async () => {
    await t.db.execute(sql`drop table if exists naive_log`);
    await t.db.execute(
      sql`create table naive_log (seq bigint generated always as identity primary key, note text)`,
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let wrote: () => void = () => {};
    const written = new Promise<void>((resolve) => {
      wrote = resolve;
    });
    const slow = t.db.transaction(async (tx) => {
      await tx.execute(sql`insert into naive_log (note) values ('slow')`); // takes seq 1
      wrote();
      await gate;
    });
    await written;
    await t.db.execute(sql`insert into naive_log (note) values ('fast')`); // seq 2, commits first

    const firstRead = await t.db.execute<{ seq: string }>(
      sql`select seq from naive_log where seq > 0`,
    );
    const cursor = Math.max(...firstRead.map((r) => Number(r.seq)));
    release();
    await slow;
    const secondRead = await t.db.execute<{ seq: string }>(
      sql`select seq from naive_log where seq > ${cursor}`,
    );
    expect(cursor).toBe(2);
    expect(secondRead).toHaveLength(0); // seq 1 committed behind the cursor and is lost forever
    await t.db.execute(sql`drop table naive_log`);
  });

  test("the applied seq of a mutation is recorded when its changes are logged", async () => {
    const mutationId = Bun.randomUUIDv7();
    await t.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('sob.mutation_id', ${mutationId}, true)`);
      await tx.insert(clientProfile).values({ name: "A" });
      await tx.insert(clientProfile).values({ name: "B" });
      await tx.execute(
        sql`insert into sync_mutation (mutation_id, device_id, kind, status) values (${mutationId}, 'dev', 'client.create', 'applied')`,
      );
    });
    const [row] = await t.db.execute<{ applied_seq: string | null }>(
      sql`select applied_seq from sync_mutation where mutation_id = ${mutationId}`,
    );
    const all = await changes();
    expect(Number(row?.applied_seq)).toBe(all.at(-1)?.seq ?? -1);
    expect(all).toHaveLength(2);
  });
});
