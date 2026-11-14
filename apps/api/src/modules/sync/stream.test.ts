import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
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
