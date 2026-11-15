import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { accountEmailOutbox } from "@sob/db";
import { createTestDatabase, type TestDatabase } from "@sob/db/testing";
import { eq } from "drizzle-orm";
import { loadConfig } from "../config";
import { FakeEmailProvider } from "../notifications/providers/fake";
import { PermanentProviderError, TransientProviderError } from "../notifications/providers/types";
import { createAccountEmailWorker, enqueueAccountEmail } from "./outbox";

const SECRET = "test-account-email-outbox-secret-0123456789";
const BASE = new Date("2026-11-15T12:00:00Z");
const request = {
  kind: "verify_email",
  to: "outbox@example.com",
  url: "https://salon.example/api/auth/verify-email?token=private-token",
  locale: "en",
  expiresInMinutes: 60,
  idempotencyKey: "private-link-id",
} as const;
let t: TestDatabase;
let now: Date;
const config = loadConfig({ BETTER_AUTH_SECRET: SECRET }).notifications;

beforeAll(async () => {
  t = await createTestDatabase("account_email_outbox");
}, 30_000);
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  now = new Date(BASE);
});
const enqueue = (key: string = request.idempotencyKey, address: string = request.to) =>
  enqueueAccountEmail(t.db, SECRET, { ...request, to: address, idempotencyKey: key }, { now });
const worker = (provider: FakeEmailProvider | null, id = "test-worker", secret = SECRET) =>
  createAccountEmailWorker({ db: t.db, secret, provider, config, now: () => now, workerId: id });
const rows = () => t.db.select().from(accountEmailOutbox);

test("accepted messages survive process replacement and store no plaintext links or addresses", async () => {
  expect(await enqueue()).toBe("queued");
  const stored = JSON.stringify(await rows());
  for (const value of [request.to, request.url, "private-token", request.idempotencyKey]) {
    expect(stored).not.toContain(value);
  }
  const mail = new FakeEmailProvider();
  expect(await worker(mail, "replacement").runOnce()).toBe(1);
  expect(mail.calls[0]?.to).toBe(request.to);
  expect(mail.calls[0]?.text).toContain(request.url);
  expect((await rows())[0]?.status).toBe("sent");
  expect((await rows())[0]?.payload).toBe("");
});

test("concurrent enqueues deduplicate links and throttle different links for the same mailbox", async () => {
  const same = await Promise.all([enqueue(), enqueue()]);
  expect(same.sort()).toEqual(["duplicate", "queued"]);
  expect(await enqueue("another-link")).toBe("throttled");
  expect(await rows()).toHaveLength(1);
  now = new Date(BASE.getTime() + 61_000);
  expect(await enqueue("another-link")).toBe("queued");
});

test("two workers never claim the same message", async () => {
  await enqueue();
  const mail = new FakeEmailProvider();
  expect(
    (await Promise.all([worker(mail, "one").runOnce(), worker(mail, "two").runOnce()])).sort(),
  ).toEqual([0, 1]);
  expect(mail.calls).toHaveLength(1);
});

test("temporary delivery failure persists a retry that another process delivers with the same key", async () => {
  await enqueue();
  const mail = new FakeEmailProvider();
  mail.failNext(1, new TransientProviderError(`SMTP cannot reach ${request.to}: ${request.url}`));
  await worker(mail).runOnce();
  const [pending] = await rows();
  expect(pending?.status).toBe("pending");
  expect(pending?.attempts).toBe(1);
  expect(JSON.stringify(pending)).not.toContain(request.to);
  now = new Date(BASE.getTime() + 3_600_000 - 1);
  await worker(mail, "restarted").runOnce();
  expect(mail.calls).toHaveLength(2);
  expect(mail.calls[0]?.idempotencyKey).toBe(mail.calls[1]?.idempotencyKey);
  expect((await rows())[0]?.status).toBe("sent");
});

test("expired links are discarded before calling the provider", async () => {
  await enqueue();
  now = new Date(BASE.getTime() + 3_600_000);
  const mail = new FakeEmailProvider();
  await worker(mail).runOnce();
  expect(mail.calls).toHaveLength(0);
  expect((await rows())[0]?.status).toBe("skipped");
  expect((await rows())[0]?.payload).toBe("");
});

test("a crashed process's lease is reclaimed, while an active lease is left alone", async () => {
  await enqueue();
  const [row] = await rows();
  if (!row) throw new Error("missing queued message");
  await t.db
    .update(accountEmailOutbox)
    .set({
      status: "processing",
      attempts: 1,
      lockedBy: "crashed",
      lockedUntil: new Date(BASE.getTime() + 1000),
    })
    .where(eq(accountEmailOutbox.id, row.id));
  const mail = new FakeEmailProvider();
  expect(await worker(mail).runOnce()).toBe(0);
  now = new Date(BASE.getTime() + 1001);
  expect(await worker(mail).runOnce()).toBe(1);
  expect(mail.calls).toHaveLength(1);
  expect((await rows())[0]?.attempts).toBe(2);
});

test("permanent failures, exhausted attempts and unreadable ciphertext terminate without exposing secrets", async () => {
  await enqueue();
  const mail = new FakeEmailProvider();
  mail.failNext(1, new PermanentProviderError(`Rejected ${request.to}`));
  await worker(mail).runOnce();
  expect((await rows())[0]?.status).toBe("failed");
  await t.reset();
  await enqueue();
  await worker(mail, "rotated", `${SECRET}-rotated`).runOnce();
  expect((await rows())[0]?.status).toBe("failed");
  expect((await rows())[0]?.lastError).toBe("payload_unreadable");
  expect(mail.calls).toHaveLength(1);
  await t.db.update(accountEmailOutbox).set({
    status: "processing",
    attempts: config.maxAttempts,
    lockedUntil: new Date(BASE.getTime() - 1),
  });
  await worker(mail).runOnce();
  expect((await rows())[0]?.status).toBe("failed");
});

test("disabling the provider retains pending mail for a later enabled worker", async () => {
  await enqueue();
  expect(await worker(null).runOnce()).toBe(0);
  expect((await rows())[0]?.status).toBe("pending");
});

test("a link expiring while an earlier message is being delivered is not sent", async () => {
  await enqueue("first", "first@example.com");
  await enqueue("second", "second@example.com");
  const mail = new FakeEmailProvider();
  mail.beforeDeliver = () => {
    now = new Date(BASE.getTime() + 3_600_000);
  };
  await worker(mail).runOnce();
  expect(mail.calls).toHaveLength(1);
  expect((await rows()).map((row) => row.status).sort()).toEqual(["sent", "skipped"]);
});

test("lease heartbeats protect a slow delivery from a second worker", async () => {
  now = new Date();
  await enqueue();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mail = new FakeEmailProvider();
  mail.beforeDeliver = async () => {
    entered();
    await held;
  };
  const options = {
    db: t.db,
    secret: SECRET,
    provider: mail,
    config: { ...config, visibilityTimeoutSeconds: 0.09 },
  };
  const first = createAccountEmailWorker({ ...options, workerId: "slow" }).runOnce();
  try {
    await started;
    await Bun.sleep(180);
    expect(await createAccountEmailWorker({ ...options, workerId: "other" }).runOnce()).toBe(0);
  } finally {
    release();
    await first;
  }
  expect(mail.calls).toHaveLength(1);
});

test("a worker that lost ownership cannot overwrite the replacement's state", async () => {
  await enqueue();
  let entered = () => {};
  let release = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mail = new FakeEmailProvider();
  mail.beforeDeliver = async () => {
    entered();
    await held;
  };
  const running = worker(mail).runOnce();
  await started;
  await t.db.update(accountEmailOutbox).set({ lockedBy: "replacement", attempts: 2 });
  release();
  await running;
  expect((await rows())[0]).toMatchObject({
    status: "processing",
    lockedBy: "replacement",
    attempts: 2,
  });
});
