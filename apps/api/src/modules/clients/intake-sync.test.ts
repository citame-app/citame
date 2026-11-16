import { afterAll, beforeAll, expect, test } from "bun:test";
import { appointment } from "@sob/db";
import { actor, json, seedFixtures, setupApiTest } from "../../../test/helpers";
import { mutation, pullAll, push } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "intake_sync" });
});
afterAll(async () => {
  await t.close();
});
test("offline replay records an actionable form rejection without poisoning the queue and retries only after a human response", async () => {
  await t.reset();
  const f = await seedFixtures(t.db);
  const owner = await actor(t, "owner", "intake-sync-owner@example.invalid");
  const client = await actor(t, "client", "intake-sync-client@example.invalid");
  const field = "0198f5a0-7b1c-7000-8000-000000000001";
  const draft = await json(
    t.app,
    "/admin/intake-forms",
    "POST",
    {
      idempotencyKey: crypto.randomUUID(),
      definition: {
        title: "Visit preferences",
        requiredAtBooking: true,
        fields: [{ id: field, kind: "text", label: "Style preference", required: true }],
      },
    },
    owner.cookie,
  );
  const form = (await draft.json()) as { id: string; version: number };
  const publication = await json(
    t.app,
    `/admin/intake-forms/${form.id}/publish`,
    "POST",
    { version: form.version },
    owner.cookie,
  );
  const published = (await publication.json()) as { published: { id: string } };
  const input = {
    id: Bun.randomUUIDv7(),
    clientId: client.clientId ?? "",
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
  };
  const queued = mutation("appointment.create", input);
  const blocked = await push(t, owner, [queued]);
  expect(blocked.status).toBe(200);
  expect(blocked.body.results[0]).toMatchObject({ status: "rejected", reason: "intake_required" });
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const response = await json(
    t.app,
    "/me/intake",
    "POST",
    {
      revisionId: published.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [field]: "Private human response" },
    },
    client.cookie,
  );
  expect(response.status).toBe(201);
  expect((await push(t, owner, [queued])).body.results[0]).toMatchObject({
    status: "rejected",
    reason: "intake_required",
  });
  const retry = await push(t, owner, [mutation("appointment.create", input)]);
  expect(retry.body.results[0]).toMatchObject({ status: "applied" });
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  expect(JSON.stringify(await pullAll(t, owner))).not.toContain("Private human response");
});
