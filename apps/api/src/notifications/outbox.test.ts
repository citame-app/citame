import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { appointment, clientProfile, reminder, salonSettings } from "@sob/db";
import { asc, eq } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";
import { mutation, push } from "../../test/sync";
import { createAppointment, updateAppointment } from "../modules/appointments/service";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let client: Actor;

beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "notify" });
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
  await t.db
    .update(clientProfile)
    .set({ email: "lucia@example.com", phone: "+5491100000000" })
    .where(eq(clientProfile.id, f.clientId));
});

const rows = () =>
  t.db
    .select()
    .from(reminder)
    .orderBy(asc(reminder.kind), asc(reminder.channel), asc(reminder.appointmentVersion));
const summary = (list: Awaited<ReturnType<typeof rows>>) =>
  list.map((r) => `${r.kind}/${r.channel}/v${r.appointmentVersion}/${r.status}`);
const book = (startsAt = MONDAY_0900) =>
  createAppointment(
    t.db,
    { staffId: f.anaId, serviceIds: [f.haircutId], startsAt, clientId: f.clientId },
    { userId: owner.userId },
    { now: NOW },
  );

describe("scheduling on create", () => {
  test("enqueues a confirmation and both reminders per channel with an address", async () => {
    const appt = await book();
    const list = await rows();
    expect(summary(list)).toEqual([
      "confirmation/email/v1/pending",
      "confirmation/sms/v1/pending",
      "reminder_24h/email/v1/pending",
      "reminder_24h/sms/v1/pending",
      "reminder_2h/email/v1/pending",
      "reminder_2h/sms/v1/pending",
    ]);
    const first = list.find((r) => r.kind === "reminder_24h");
    // Monday 09:00 Buenos Aires = 12:00Z; Sunday 09:00 local is 24 h earlier.
    expect(first?.scheduledFor.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(list.find((r) => r.kind === "reminder_2h")?.scheduledFor.toISOString()).toBe(
      "2026-03-09T10:00:00.000Z",
    );
    const confirmation = list.find((r) => r.kind === "confirmation");
    expect(confirmation?.scheduledFor.toISOString()).toBe(NOW.toISOString());
    expect(list.every((r) => r.appointmentId === appt.id)).toBe(true);
  });

  test("skips channels the client has no address for", async () => {
    await t.db.update(clientProfile).set({ phone: null });
    await book();
    expect((await rows()).every((r) => r.channel === "email")).toBe(true);
  });

  test("a booking that fails leaves no reminders behind", async () => {
    await book();
    const clash = book().catch((e: unknown) => e);
    expect(await clash).toBeInstanceOf(Error);
    expect(await rows()).toHaveLength(6);
  });

  test("honours the configured lead times and a disabled reminder", async () => {
    await t.db
      .update(salonSettings)
      .set({ reminderFirstLeadMinutes: null, reminderSecondLeadMinutes: 180 });
    await book();
    const kinds = (await rows()).filter((r) => r.channel === "email").map((r) => r.kind);
    expect(kinds).toEqual(["confirmation", "reminder_2h"]);
    const second = (await rows()).find((r) => r.kind === "reminder_2h");
    expect(second?.scheduledFor.toISOString()).toBe("2026-03-09T09:00:00.000Z");
  });

  test("REST bookings by a client schedule too", async () => {
    await t.db
      .update(clientProfile)
      .set({ email: "c@example.com" })
      .where(eq(clientProfile.id, client.clientId ?? ""));
    const res = await json(
      t.app,
      "/appointments",
      "POST",
      { staffId: f.anaId, serviceIds: [f.haircutId], startsAt: MONDAY_0900 },
      client.cookie,
    );
    expect(res.status).toBe(201);
    const list = await rows();
    expect(list.map((r) => r.kind)).toContain("confirmation");
  });

  test("sync push (desktop) bookings schedule too", async () => {
    const create = mutation("appointment.create", {
      id: Bun.randomUUIDv7(),
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      startsAt: MONDAY_0900,
      clientId: f.clientId,
    });
    const { body } = await push(t, owner, [create]);
    expect(body.results[0]?.status).toBe("applied");
    expect((await rows()).map((r) => r.kind)).toContain("reminder_24h");
  });
});

describe("reschedule", () => {
  test("cancels the pending schedule and issues a fresh one with a rescheduled notice", async () => {
    const appt = await book();
    const moved = await updateAppointment(
      t.db,
      appt.id,
      { version: 1, startsAt: "2026-03-09T14:00:00.000Z" },
      { userId: owner.userId },
      { now: NOW },
    );
    expect(moved.version).toBe(2);
    const list = await rows();
    const email = list.filter((r) => r.channel === "email");
    expect(summary(email)).toEqual([
      "confirmation/email/v1/cancelled",
      "reminder_24h/email/v1/cancelled",
      "reminder_24h/email/v2/pending",
      "reminder_2h/email/v1/cancelled",
      "reminder_2h/email/v2/pending",
      "rescheduled/email/v2/pending",
    ]);
    const fresh = email.find((r) => r.kind === "reminder_2h" && r.appointmentVersion === 2);
    expect(fresh?.scheduledFor.toISOString()).toBe("2026-03-09T12:00:00.000Z");
  });

  test("keeps the schedule when only the notes change", async () => {
    const appt = await book();
    await updateAppointment(
      t.db,
      appt.id,
      { version: 1, notes: "bring photos" },
      { userId: owner.userId },
      { now: NOW },
    );
    expect(summary(await rows()).filter((s) => s.endsWith("/cancelled"))).toEqual([]);
    expect(await rows()).toHaveLength(6);
  });

  test("a rejected reschedule changes nothing", async () => {
    const appt = await book();
    const err = await updateAppointment(
      t.db,
      appt.id,
      { version: 1, startsAt: "2026-03-09T03:00:00.000Z" },
      { userId: owner.userId },
      { now: NOW },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(summary(await rows()).every((s) => s.endsWith("/v1/pending"))).toBe(true);
  });
});

describe("cancel and close", () => {
  test("cancelling cancels pending reminders and enqueues a cancellation notice", async () => {
    const appt = await book();
    await updateAppointment(
      t.db,
      appt.id,
      { version: 1, status: "cancelled" },
      { userId: owner.userId },
      { now: NOW },
    );
    const email = (await rows()).filter((r) => r.channel === "email");
    expect(summary(email)).toEqual([
      "confirmation/email/v1/cancelled",
      "reminder_24h/email/v1/cancelled",
      "reminder_2h/email/v1/cancelled",
      "cancellation/email/v2/pending",
    ]);
  });

  test("an already-sent confirmation stays sent when the appointment is cancelled", async () => {
    const appt = await book();
    await t.db.update(reminder).set({ status: "sent" }).where(eq(reminder.kind, "confirmation"));
    await updateAppointment(
      t.db,
      appt.id,
      { version: 1, status: "cancelled" },
      { userId: owner.userId },
      { now: NOW },
    );
    const conf = (await rows()).filter((r) => r.kind === "confirmation");
    expect(conf.every((r) => r.status === "sent")).toBe(true);
  });

  test("completing an appointment cancels pending reminders without a notice", async () => {
    const appt = await book();
    await t.db
      .update(appointment)
      .set({ startsAt: new Date("2026-03-01T10:00:00Z"), endsAt: new Date("2026-03-01T11:00:00Z") })
      .where(eq(appointment.id, appt.id));
    await updateAppointment(
      t.db,
      appt.id,
      { version: 1, status: "completed" },
      { userId: owner.userId },
      { now: NOW },
    );
    const list = await rows();
    expect(list.some((r) => r.kind === "cancellation")).toBe(false);
    expect(list.every((r) => r.status === "cancelled")).toBe(true);
  });
});
