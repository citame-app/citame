import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { intakeAdminFormSchema, intakeSubmissionSchema } from "@sob/contracts";
import {
  appointment,
  cashSession,
  marketingCampaign,
  marketingDelivery,
  staffProfile,
} from "@sob/db";
import { eq } from "drizzle-orm";
import { clientPhotoFixture } from "../../../test/client-photo-fixture";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { mutation, pull, push, uuid } from "../../../test/sync";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "sync", deps: { syncHeartbeatMs: 40 } });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  [owner, client] = await Promise.all([
    actor(t, "owner", "owner@example.com"),
    actor(t, "client", "c@example.com"),
  ]);
});

/** Minimal SSE reader: accumulates text until a predicate matches or the timeout elapses. */
function reader(res: Response) {
  const body = res.body?.getReader();
  if (!body) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  return {
    get text() {
      return text;
    },
    async until(predicate: (text: string) => boolean, timeoutMs = 3000, allowEnd = false) {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(text)) {
        const left = deadline - Date.now();
        if (left <= 0)
          throw new Error(`timed out waiting for SSE data; got: ${JSON.stringify(text)}`);
        const chunk = await Promise.race([
          body.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), left)),
        ]);
        if (chunk === null) continue;
        if (chunk.done) {
          if (allowEnd) return { done: true };
          throw new Error(`stream ended early; got: ${JSON.stringify(text)}`);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { done: false };
    },
    cancel: () => body.cancel(),
  };
}

const open = (who: Actor | null) => json(t.app, "/sync/stream", "GET", undefined, who?.cookie);
const nudges = (text: string) =>
  [...text.matchAll(/event: change\ndata: (\{[^\n]*\})/g)].map(
    (m) => (JSON.parse(m[1] ?? "{}") as { seq: number }).seq,
  );

describe("GET /sync/stream", () => {
  test("requires a session and the front-desk role", async () => {
    expect((await open(null)).status).toBe(401);
    expect((await open(client)).status).toBe(403);
  });

  test("opens an event stream and announces the current head right away", async () => {
    const res = await open(owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const head = (await pull(t, owner)).headSeq;
    const r = reader(res);
    await r.until((text) => nudges(text).length >= 1);
    expect(nudges(r.text)[0]).toBe(head);
    await r.cancel();
  });

  test("sends heartbeat comments while idle", async () => {
    const r = reader(await open(owner));
    await r.until((text) => (text.match(/^: ping$/gm) ?? []).length >= 2);
    await r.cancel();
  });

  test("a REST write nudges connected clients with the new head", async () => {
    const r = reader(await open(owner));
    await r.until((text) => nudges(text).length >= 1);
    const res = await json(
      t.app,
      "/appointments",
      "POST",
      { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900, clientId: f.clientId },
      owner.cookie,
    );
    expect(res.status).toBe(201);
    const head = (await pull(t, owner)).headSeq;
    await r.until((text) => nudges(text).includes(head));
    await r.cancel();
  });

  test("portrait changes nudge connected staff without putting portrait data into the replica", async () => {
    const r = reader(await open(owner));
    await r.until((text) => nudges(text).length >= 1);
    let cursor = nudges(r.text)[0]!;
    const path = `/admin/staff/${f.anaId}/portrait`;
    const [staffBefore] = await t.db
      .select({ updatedAt: staffProfile.updatedAt })
      .from(staffProfile)
      .where(eq(staffProfile.id, f.anaId));
    const unchangedEditClock = staffBefore!.updatedAt.toISOString();
    const imageBase64 = (await clientPhotoFixture()).toString("base64");
    async function change(endpoint: string, body: unknown) {
      const response = await json(t.app, endpoint, "PUT", body, owner.cookie);
      expect(response.status).toBe(200);
      const page = await pull(t, owner, { since: cursor });
      expect(page.changes).toEqual([
        expect.objectContaining({
          id: f.anaId,
          entity: "staff",
          op: "upsert",
          data: {
            id: f.anaId,
            active: true,
            displayName: "Ana",
            userId: null,
            updatedAt: unchangedEditClock,
          },
        }),
      ]);
      expect(page.nextCursor).toBeGreaterThan(cursor);
      cursor = page.nextCursor;
      await r.until((text) => nudges(text).includes(cursor));
      return (await response.json()) as { version: string | null };
    }
    try {
      const saved = await change(path, { version: null, imageBase64 });
      const visible = await change(`${path}/publication`, {
        version: saved.version,
        published: true,
      });
      const unchanged = await json(
        t.app,
        `${path}/publication`,
        "PUT",
        { version: visible.version, published: true },
        owner.cookie,
      );
      expect(unchanged.status).toBe(200);
      expect((await pull(t, owner, { since: cursor })).nextCursor).toBe(cursor);
      await change(path, { version: visible.version, imageBase64: null });
    } finally {
      await r.cancel();
    }
  });

  test("a sync push nudges too, and every connection hears it", async () => {
    const a = reader(await open(owner));
    const b = reader(await open(owner));
    await Promise.all([
      a.until((x) => nudges(x).length >= 1),
      b.until((x) => nudges(x).length >= 1),
    ]);
    await push(t, owner, [mutation("client.create", { id: uuid(), name: "Streamed" })]);
    const head = (await pull(t, owner)).headSeq;
    await Promise.all([
      a.until((x) => nudges(x).includes(head)),
      b.until((x) => nudges(x).includes(head)),
    ]);
    await Promise.all([a.cancel(), b.cancel()]);
  });

  test("background commits wake connected views without exposing payment records", async () => {
    const r = reader(await open(owner));
    try {
      await r.until((text) => nudges(text).length >= 1);
      const since = nudges(r.text)[0] ?? 0;
      await t.db.transaction(async (tx) => {
        await tx.insert(cashSession).values({ openingCents: 2300, openedBy: owner.userId });
        await tx.update(cashSession).set({ openingCents: 2500 });
      });
      const response = await pull(t, owner, { since });
      expect(response.changes).toEqual([]);
      expect(response.refresh).toEqual(["commerce"]);
      expect(response.nextCursor).toBe(response.headSeq);
      expect(response.nextCursor - since).toBe(1);
      await r.until((text) => nudges(text).includes(response.headSeq), 2500);
      const restricted = await actor(t, "staff", "restricted@example.com", {
        staffProfileId: f.anaId,
      });
      await t.db
        .update(staffProfile)
        .set({ accessPreset: "restricted" })
        .where(eq(staffProfile.id, f.anaId));
      const limited = await pull(t, restricted, { since });
      expect(limited.refresh).toBeUndefined();
      expect(limited.nextCursor).toBeGreaterThanOrEqual(response.nextCursor);
    } finally {
      await r.cancel();
    }
  });

  test("review delivery commits wake opted-in managers without replicating review data", async () => {
    const id = uuid();
    const campaign = uuid();
    const delivery = uuid();
    const now = new Date();
    await t.db.insert(appointment).values({
      id,
      clientId: f.clientId,
      staffId: f.anaId,
      status: "completed",
      startsAt: new Date(now.getTime() - 7200000),
      endsAt: new Date(now.getTime() - 3600000),
    });
    await t.db.insert(marketingCampaign).values({
      id: campaign,
      name: "Synthetic review invitation",
      channel: "email",
      purpose: "review_request",
      requestDigest: "synthetic",
    });
    const professional = await actor(t, "staff", "review-professional@example.test", {
      staffProfileId: f.anaId,
    });
    const manager = await actor(t, "staff", "review-manager@example.test", {
      staffProfileId: f.beaId,
    });
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "manager" })
      .where(eq(staffProfile.id, f.beaId));
    const stream = reader(await open(owner));
    try {
      await stream.until((message) => nudges(message).length > 0);
      const since = nudges(stream.text)[0]!;
      await t.db.transaction(async (tx) => {
        await tx.insert(marketingDelivery).values({
          id: delivery,
          campaignId: campaign,
          clientId: f.clientId,
          channel: "email",
          occurrence: "once",
          reviewAppointmentId: id,
          scheduledFor: now,
        });
        await tx
          .update(marketingDelivery)
          .set({ status: "processing" })
          .where(eq(marketingDelivery.id, delivery));
      });
      const first = await pull(t, owner, { since, reviewRequests: "1" });
      expect(first.refresh).toEqual(["review_requests"]);
      expect(first.changes).toEqual([]);
      // The same transaction touches each subscribed view once, even
      // when an older subscriber filters out the Marketing channel.
      expect(first.nextCursor - since).toBe(2);
      const both = await pull(t, owner, { since, reviewRequests: "1", marketingViews: "1" });
      expect([...(both.refresh ?? [])].sort()).toEqual(["marketing", "review_requests"]);
      expect(both.nextCursor).toBe(first.nextCursor);
      expect((await pull(t, owner, { since })).refresh).toBeUndefined();
      expect((await pull(t, manager, { since, reviewRequests: "1" })).refresh).toEqual([
        "review_requests",
      ]);
      const limited = await pull(t, professional, { since, reviewRequests: "1" });
      expect(limited.refresh).toBeUndefined();
      expect(limited.nextCursor).toBe(first.nextCursor);
      await stream.until((message) => nudges(message).includes(first.headSeq), 2500);

      await t.db
        .update(marketingDelivery)
        .set({ lockedUntil: now })
        .where(eq(marketingDelivery.id, delivery));
      expect((await pull(t, owner, { since: first.nextCursor, reviewRequests: "1" })).headSeq).toBe(
        first.headSeq,
      );
      await t.db
        .update(marketingDelivery)
        .set({ status: "sent" })
        .where(eq(marketingDelivery.id, delivery));
      const sent = await pull(t, owner, { since: first.nextCursor, reviewRequests: "1" });
      expect(sent.refresh).toEqual(["review_requests"]);
      expect(sent.changes).toEqual([]);
      await stream.until((message) => nudges(message).includes(sent.headSeq), 2500);
    } finally {
      await stream.cancel();
    }
  });

  test("promotion changes wake permitted clients without including discount details", async () => {
    const receptionist = await actor(t, "staff", "promo-reception@example.test", {
      staffProfileId: f.anaId,
    });
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "receptionist" })
      .where(eq(staffProfile.id, f.anaId));
    const stream = reader(await open(owner));
    try {
      await stream.until((message) => nudges(message).length > 0);
      const since = nudges(stream.text)[0]!;
      const created = await json(
        t.app,
        "/admin/rewards/promotions",
        "POST",
        {
          code: "SYNTHETIC_STREAM",
          name: "Synthetic private promotion",
          kind: "fixed",
          value: 1200,
        },
        owner.cookie,
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const optedIn = await pull(t, owner, { since, promotionViews: "1" });
      expect(optedIn.refresh).toEqual(["promotions"]);
      expect(optedIn.changes).toEqual([]);
      expect(JSON.stringify(optedIn)).not.toContain("SYNTHETIC_STREAM");
      const legacy = await pull(t, owner, { since, marketingViews: "1" });
      const limited = await pull(t, receptionist, { since, promotionViews: "1" });
      expect(legacy.refresh).toBeUndefined();
      expect(limited.refresh).toBeUndefined();
      expect(legacy.nextCursor).toBe(optedIn.nextCursor);
      await stream.until((message) => nudges(message).includes(optedIn.headSeq), 2500);
      expect(stream.text).not.toContain("SYNTHETIC_STREAM");
    } finally {
      await stream.cancel();
    }
  });

  test("intake writes wake authorized compatible clients without carrying private content", async () => {
    const professional = await actor(t, "staff", "intake-professional@example.test", {
      staffProfileId: f.anaId,
    });
    const restricted = await actor(t, "staff", "intake-restricted@example.test", {
      staffProfileId: f.beaId,
    });
    await t.db
      .update(staffProfile)
      .set({ accessPreset: "restricted" })
      .where(eq(staffProfile.id, f.beaId));
    const stream = reader(await open(owner));
    try {
      await stream.until((text) => nudges(text).length > 0);
      const [since] = nudges(stream.text);
      if (since === undefined) throw new Error("Missing initial sync cursor");
      const field = uuid();
      const privateText = "Synthetic confidential note";
      const form = intakeAdminFormSchema.parse(
        await (
          await json(
            t.app,
            "/admin/intake-forms",
            "POST",
            {
              idempotencyKey: uuid(),
              definition: {
                title: "Synthetic private form",
                allowTeamResponses: true,
                fields: [{ id: field, label: "Notes", kind: "text" }],
              },
            },
            owner.cookie,
          )
        ).json(),
      );
      const published = intakeAdminFormSchema.parse(
        await (
          await json(
            t.app,
            `/admin/intake-forms/${form.id}/publish`,
            "POST",
            { version: form.version },
            owner.cookie,
          )
        ).json(),
      );
      expect(published.published).not.toBeNull();
      const forms = await pull(t, owner, { since, intakeViews: "1" });
      expect(forms.refresh).toEqual(["intake_forms"]);
      expect(forms.changes).toEqual([]);
      expect((await pull(t, professional, { since, intakeViews: "1" })).refresh).toBeUndefined();
      expect((await pull(t, owner, { since })).refresh).toBeUndefined();
      await stream.until((text) => nudges(text).includes(forms.headSeq));

      const packet = {
        idempotencyKey: uuid(),
        confirmation: true,
        revisionId: published.published?.id,
        answers: { [field]: privateText },
      };
      const path = `/admin/clients/${f.clientId}/intake`;
      const record = intakeSubmissionSchema.parse(
        await (await json(t.app, path, "POST", packet, owner.cookie)).json(),
      );
      const views = await pull(t, owner, { since: forms.nextCursor, intakeViews: "1" });
      expect(views.refresh).toEqual(["intake_records"]);
      expect(views.changes).toEqual([]);
      expect(JSON.stringify(views)).not.toContain(privateText);
      expect(JSON.stringify(views)).not.toContain(record.id);
      const allowed = await pull(t, professional, { since: forms.nextCursor, intakeViews: "1" });
      expect(allowed.refresh).toEqual(["intake_records"]);
      const denied = await pull(t, restricted, { since: forms.nextCursor, intakeViews: "1" });
      expect(denied.refresh).toBeUndefined();
      expect(denied.nextCursor).toBe(views.nextCursor);
      expect((await pull(t, owner, { since: forms.nextCursor })).refresh).toBeUndefined();
      await stream.until((text) => nudges(text).includes(views.headSeq));
      expect(stream.text).not.toContain(privateText);
      expect(stream.text).not.toContain(record.id);

      const replay = intakeSubmissionSchema.parse(
        await (await json(t.app, path, "POST", packet, owner.cookie)).json(),
      );
      expect(replay.id).toBe(record.id);
      expect((await pull(t, owner, { since: views.nextCursor, intakeViews: "1" })).headSeq).toBe(
        views.headSeq,
      );
    } finally {
      await stream.cancel();
    }
  });

  test("shutdown ends open streams cleanly", async () => {
    const other = await setupApiTest({ dbSuffix: "sync", deps: { syncHeartbeatMs: 40 } });
    try {
      await other.reset();
      const who = await actor(other, "owner", "o2@example.com");
      const r = reader(await json(other.app, "/sync/stream", "GET", undefined, who.cookie));
      await r.until((x) => nudges(x).length >= 1);
      await other.app.shutdown();
      const end = await r.until(() => false, 3000, true);
      expect(end.done).toBe(true);
    } finally {
      await other.close();
    }
  });

  test("is rate limited per caller", async () => {
    const limited = await setupApiTest({
      dbSuffix: "sync",
      env: { SYNC_STREAM_RATE_LIMIT_MAX: "2" },
    });
    try {
      await limited.reset();
      const who = await actor(limited, "owner", "o3@example.com");
      const go = () => json(limited.app, "/sync/stream", "GET", undefined, who.cookie);
      const first = await go();
      const second = await go();
      const third = await go();
      expect([first.status, second.status, third.status]).toEqual([200, 200, 429]);
      expect(third.headers.get("retry-after")).not.toBeNull();
      await Promise.all([first.body?.cancel(), second.body?.cancel()]);
    } finally {
      await limited.close();
    }
  });
});
