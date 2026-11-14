import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointment, clientProfile, notificationPreference, reminder } from "@sob/db";
import { asc, eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";
import type { NotificationConfig } from "../config";
import { createAppointment, updateAppointment } from "../modules/appointments/service";
import { createMetrics } from "./metrics";
import { FakeEmailProvider, FakeSmsProvider } from "./providers/fake";
import { PermanentProviderError } from "./providers/types";
import { claimDue } from "./queue";
import { createNotificationWorker } from "./worker";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let email: FakeEmailProvider;
let sms: FakeSmsProvider;
let clock: Date;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "notify" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@example.com");
  await t.db
    .update(clientProfile)
    .set({ email: "lucia@example.com", phone: "+54 9 11 0000-0000" })
    .where(eq(clientProfile.id, f.clientId));
  email = new FakeEmailProvider();
  sms = new FakeSmsProvider();
  clock = new Date(NOW);
});

const config = (over: Partial<NotificationConfig> = {}): NotificationConfig => ({
  ...t.config.notifications,
  pollIntervalMs: 20,
  batchSize: 5,
  visibilityTimeoutSeconds: 60,
  maxAttempts: 3,
  backoffBaseSeconds: 10,
  backoffMaxSeconds: 100,
  publicUrl: "https://salon.example",
  ...over,
});

function worker(
  id: string,
  over: {
    cfg?: Partial<NotificationConfig>;
    email?: FakeEmailProvider | null;
    sms?: FakeSmsProvider | null;
  } = {},
) {
  return createNotificationWorker({
    db: t.db,
    config: config(over.cfg),
    providers: {
      email: over.email === undefined ? email : over.email,
      sms: over.sms === undefined ? sms : over.sms,
    },
    now: () => clock,
    workerId: id,
    random: () => 0.5,
    log: () => {},
    metrics: createMetrics(),
  });
}

async function book(startsAt = MONDAY_0900) {
  return createAppointment(
    t.db,
    { staffId: f.anaId, serviceIds: [f.haircutId, f.colorId], startsAt, clientId: f.clientId },
    { userId: owner.userId },
    { now: NOW },
  );
}
const rows = () => t.db.select().from(reminder).orderBy(asc(reminder.kind), asc(reminder.channel));
const byKind = async (kind: string, channel = "email") =>
  (await rows()).find((r) => r.kind === kind && r.channel === channel);

describe("delivery", () => {
  test("sends only what is due, with the rendered message and provider id recorded", async () => {
    await book();
    const w = worker("w1");
    await w.runOnce();
    expect(email.delivered.size).toBe(1); // the confirmation; reminders are in the future
    const [message] = [...email.delivered.values()];
    expect(message?.to).toBe("lucia@example.com");
    expect(message?.subject).toContain("confirmed");
    expect(message?.text).toContain("Haircut, Color");
    expect(message?.text).toContain("9:00"); // salon time, not UTC
    expect(message?.ics).toContain("BEGIN:VEVENT");
    const row = await byKind("confirmation");
    expect(row?.status).toBe("sent");
    expect(row?.providerMessageId).toBe(`fake-${row?.id}`);
    expect(row?.attempts).toBe(1);
    expect((await byKind("reminder_24h"))?.status).toBe("pending");
  });

  test("sends the reminder once its time arrives, with an opt-out link and headers", async () => {
    await book();
    await worker("w1").runOnce();
    clock = new Date("2026-03-08T12:00:00Z");
    await worker("w1").runOnce();
    const reminderRow = await byKind("reminder_24h");
    expect(reminderRow?.status).toBe("sent");
    const message = email.delivered.get(reminderRow?.id ?? "");
    expect(message?.text).toContain("https://salon.example/notifications/opt-out?token=");
    expect(message?.headers?.["List-Unsubscribe"]).toContain(
      "https://salon.example/api/notifications/opt-out?token=",
    );
    expect(message?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("uses the client's locale", async () => {
    await t.db
      .update(clientProfile)
      .set({ locale: "es-AR" })
      .where(eq(clientProfile.id, f.clientId));
    await book();
    await worker("w1").runOnce();
    expect([...email.delivered.values()][0]?.subject).toContain("Turno confirmado");
  });

  test("sends a cancellation notice after cancelling", async () => {
    const appt = await book();
    await updateAppointment(
      t.db,
      appt.id,
      { version: 1, status: "cancelled" },
      { userId: owner.userId },
      { now: NOW },
    );
    await worker("w1").runOnce();
    const kinds = [...email.delivered.values()].map((m) => m.subject);
    expect(kinds).toHaveLength(1);
    expect(kinds[0]?.toLowerCase()).toContain("cancel");
  });
});

describe("skipping", () => {
  test("SMS is skipped without consent and sent with it", async () => {
    await book();
    await worker("w1").runOnce();
    expect((await byKind("confirmation", "sms"))?.status).toBe("skipped");
    expect((await byKind("confirmation", "sms"))?.lastError).toBe("opted_out");
    expect(sms.delivered.size).toBe(0);

    await t.db.insert(notificationPreference).values([
      { clientId: f.clientId, channel: "sms", category: "transactional", enabled: true },
      { clientId: f.clientId, channel: "sms", category: "reminder", enabled: true },
    ]);
    await t.db
      .update(reminder)
      .set({ status: "pending", lastError: null, attempts: 0 })
      .where(eq(reminder.channel, "sms"));
    await worker("w1").runOnce();
    expect(sms.delivered.size).toBe(1);
    expect([...sms.delivered.values()][0]?.to).toBe("+5491100000000");
  });

  test("a reminder opt-out stops reminders but not the confirmation", async () => {
    await t.db.insert(notificationPreference).values({
      clientId: f.clientId,
      channel: "email",
      category: "reminder",
      enabled: false,
    });
    await book();
    clock = new Date("2026-03-09T10:00:00Z");
    await worker("w1").runOnce();
    expect((await byKind("confirmation"))?.status).toBe("sent");
    expect((await byKind("reminder_24h"))?.status).toBe("skipped");
    expect((await byKind("reminder_2h"))?.lastError).toBe("opted_out");
  });

  test("an appointment cancelled behind the outbox's back is not reminded", async () => {
    const appt = await book();
    await t.db.update(appointment).set({ status: "cancelled" }).where(eq(appointment.id, appt.id));
    clock = new Date("2026-03-08T12:00:00Z");
    await worker("w1").runOnce();
    expect((await byKind("reminder_24h"))?.lastError).toBe("appointment_not_booked");
    expect(email.delivered.size).toBe(0);
  });

  test("a disabled provider skips instead of failing", async () => {
    await book();
    await worker("w1", { email: null }).runOnce();
    expect((await byKind("confirmation"))?.status).toBe("skipped");
    expect((await byKind("confirmation"))?.lastError).toBe("channel_disabled");
  });

  test("a client without a valid e164 phone is skipped for SMS", async () => {
    await t.db
      .update(clientProfile)
      .set({ phone: "4444-5555" })
      .where(eq(clientProfile.id, f.clientId));
    await t.db
      .insert(notificationPreference)
      .values({ clientId: f.clientId, channel: "sms", category: "transactional", enabled: true });
    await book();
    await worker("w1").runOnce();
    expect((await byKind("confirmation", "sms"))?.lastError).toBe("invalid_phone");
  });
});

describe("retries and dead letter", () => {
  test("a transient failure is retried later with exponential backoff", async () => {
    await book();
    email.failNext(1);
    const metrics = createMetrics();
    const w = createNotificationWorker({
      db: t.db,
      config: config(),
      providers: { email, sms: null },
      now: () => clock,
      workerId: "w1",
      random: () => 0.5,
      log: () => {},
      metrics,
    });
    await w.runOnce();
    const failed = await byKind("confirmation");
    expect(failed?.status).toBe("pending");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toContain("simulated outage");
    // base 10s, attempt 1, jitter factor 0.5 => [5s, 10s] window with random()=.5 => 7.5s
    expect((failed?.scheduledFor.getTime() ?? 0) - clock.getTime()).toBe(7500);
    expect(metrics.snapshot().retried).toBe(1);

    await w.runOnce(); // not due yet
    expect(email.calls).toHaveLength(1);
    clock = new Date(clock.getTime() + 8000);
    await w.runOnce();
    expect((await byKind("confirmation"))?.status).toBe("sent");
    expect(metrics.snapshot().sent).toBe(1);
  });

  test("backoff doubles per attempt and is capped", async () => {
    await book();
    email.failNext(10);
    const w = worker("w1", { email, sms: null });
    const delays: number[] = [];
    for (let i = 0; i < 2; i++) {
      await w.runOnce();
      const row = await byKind("confirmation");
      delays.push((row?.scheduledFor.getTime() ?? 0) - clock.getTime());
      clock = new Date(row?.scheduledFor ?? clock);
    }
    expect(delays).toEqual([7500, 15000]);
  });

  test("dead-letters after the maximum number of attempts", async () => {
    await book();
    email.failNext(10);
    const metrics = createMetrics();
    const w = createNotificationWorker({
      db: t.db,
      config: config(),
      providers: { email, sms: null },
      now: () => clock,
      workerId: "w1",
      random: () => 0.5,
      log: () => {},
      metrics,
    });
    for (let i = 0; i < 5; i++) {
      await w.runOnce();
      clock = new Date(clock.getTime() + 3_600_000);
    }
    const row = await byKind("confirmation");
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(3);
    expect(email.calls).toHaveLength(3);
    expect(metrics.snapshot().dead_lettered).toBe(1);
  });

  test("a permanent error fails immediately", async () => {
    await book();
    email.failNext(1, new PermanentProviderError("550 no such user"));
    await worker("w1", { sms: null }).runOnce();
    const row = await byKind("confirmation");
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain("550");
  });
});

describe("crash recovery and visibility timeout", () => {
  test("a job claimed by a dead worker is invisible until the lease expires, then retried", async () => {
    await book();
    const lost = await claimDue(t.db, {
      now: clock,
      limit: 10,
      visibilitySeconds: 60,
      workerId: "dead",
      maxAttempts: 3,
    });
    expect(lost.length).toBeGreaterThan(0);
    await worker("w2").runOnce();
    expect(email.calls).toHaveLength(0); // still leased

    clock = new Date(clock.getTime() + 61_000);
    await worker("w2").runOnce();
    expect(email.delivered.size).toBe(1);
    const row = await byKind("confirmation");
    expect(row?.status).toBe("sent");
    expect(row?.attempts).toBe(2);
    expect(row?.lockedBy).toBe("w2");
  });

  test("crash AFTER the provider accepted: the retry reuses the idempotency key, one delivery", async () => {
    await book();
    const [claimed] = await claimDue(t.db, {
      now: clock,
      limit: 1,
      visibilitySeconds: 60,
      workerId: "dead",
      maxAttempts: 3,
    });
    // The dead worker got as far as the provider, then the process vanished.
    await email.send({
      to: "lucia@example.com",
      subject: "s",
      text: "t",
      html: "h",
      idempotencyKey: claimed?.id ?? "",
    });
    clock = new Date(clock.getTime() + 61_000);
    await worker("w2").runOnce();
    expect(email.calls).toHaveLength(2); // two attempts...
    expect(email.delivered.size).toBe(1); // ...one message recorded by the provider
    expect((await byKind("confirmation"))?.status).toBe("sent");
  });

  test("an expired lease on an exhausted job is dead-lettered, not retried forever", async () => {
    await book();
    await t.db
      .update(reminder)
      .set({
        status: "processing",
        attempts: 3,
        lockedUntil: new Date(clock.getTime() - 1000),
        lockedBy: "dead",
      })
      .where(eq(reminder.kind, "confirmation"));
    await worker("w1").runOnce();
    expect((await byKind("confirmation"))?.status).toBe("failed");
    expect(email.calls).toHaveLength(0);
  });

  test("a worker that lost its lease does not overwrite the new owner's result", async () => {
    await book();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    email.beforeDeliver = () => gate;
    const slow = worker("slow", { sms: null });
    const running = slow.runOnce();
    await Bun.sleep(100);
    clock = new Date(clock.getTime() + 61_000);
    email.beforeDeliver = undefined;
    await worker("fast", { sms: null }).runOnce();
    release();
    await running;
    const row = await byKind("confirmation");
    expect(row?.status).toBe("sent");
    expect(row?.lockedBy).toBe("fast");
    expect(email.delivered.size).toBe(1);
  });
});

describe("concurrency", () => {
  test("many workers never send the same reminder twice", async () => {
    const appt = await book();
    await t.db.delete(reminder);
    await t.db.insert(reminder).values(
      Array.from({ length: 60 }, (_, i) => ({
        appointmentId: appt.id,
        kind: "confirmation" as const,
        channel: "email" as const,
        appointmentVersion: i + 1,
        scheduledFor: new Date(NOW.getTime() - 1000),
      })),
    );
    const workers = Array.from({ length: 6 }, (_, i) => worker(`w${i}`, { sms: null }));
    await Promise.all(
      workers.map(async (w) => {
        while ((await w.runOnce()) > 0);
      }),
    );
    const all = await rows();
    expect(all.every((r) => r.status === "sent" && r.attempts === 1)).toBe(true);
    expect(email.calls).toHaveLength(60);
    expect(email.delivered.size).toBe(60);
    expect(new Set(all.map((r) => r.lockedBy)).size).toBeGreaterThan(1);
  });
});

describe("lifecycle", () => {
  test("start polls for work and stop waits for the in-flight send", async () => {
    await book();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    email.beforeDeliver = async () => {
      started();
      await gate;
    };
    const w = worker("w1", { sms: null });
    w.start();
    await inFlight;
    let stopped = false;
    const stopping = w.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(100);
    expect(stopped).toBe(false); // still sending
    release();
    await stopping;
    expect((await byKind("confirmation"))?.status).toBe("sent");
    await book("2026-03-16T12:00:00.000Z").catch(() => {});
    const before = email.calls.length;
    await Bun.sleep(100);
    expect(email.calls.length).toBe(before); // stopped workers no longer poll
  });
});
