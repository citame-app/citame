import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { intakeRevision, intakeSubmission, user } from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { lockScheduling, type Tx } from "../../tx";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
const call = (path: string, body: unknown) => json(t.app, path, "POST", body, owner.cookie);
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "intake_auth" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "intake-auth-owner@example.invalid");
});
async function revokeWhileWaiting(action: () => Promise<Response> | Response) {
  let release: () => void = () => {};
  let ready: () => void = () => {};
  let writer: Tx | undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transaction = t.db.transaction(async (tx) => {
    writer = tx;
    await lockScheduling(tx);
    ready();
    await resume;
  });
  await held;
  const pending = Promise.resolve(action());
  try {
    let waiting = false;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where l.locktype='advisory' and not l.granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
    if (!writer) throw new Error("Missing lock holder");
    await writer.update(user).set({ role: "client" }).where(eq(user.id, owner.userId));
  } finally {
    release();
    await transaction;
  }
  return pending;
}
async function draft() {
  const response = await call("/admin/intake-forms", {
    idempotencyKey: crypto.randomUUID(),
    definition: {
      title: "Preferences",
      fields: [{ id: "0198f5a0-7b1c-7000-8000-000000000001", label: "Preferences", kind: "text" }],
      allowTeamResponses: true,
    },
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; version: number; published: { id: string } }>;
}
test("a queued publication cannot use management rights revoked before its transaction runs", async () => {
  const form = await draft();
  const response = await revokeWhileWaiting(() =>
    call(`/admin/intake-forms/${form.id}/publish`, { version: form.version }),
  );
  expect(response.status).toBe(403);
  expect(await t.db.select().from(intakeRevision)).toHaveLength(0);
});
test("a queued team response cannot retain another client's write access after demotion", async () => {
  const form = await draft();
  const published = await call(`/admin/intake-forms/${form.id}/publish`, { version: form.version });
  const active = (await published.json()) as typeof form;
  const response = await revokeWhileWaiting(() =>
    call(`/admin/clients/${f.clientId}/intake`, {
      revisionId: active.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: {},
    }),
  );
  expect([403, 404]).toContain(response.status);
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(0);
});
