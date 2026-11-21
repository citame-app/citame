import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointment,
  appointmentContext,
  appointmentService,
  auditLog,
  checkout,
  oauthConsent,
  service,
  staffProfile,
  timeOff,
} from "@sob/db";
import { eq } from "drizzle-orm";
import {
  actor,
  json,
  MONDAY,
  MONDAY_0900,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../test/helpers";
import { callTool, listTools, rpc, tokenFor, tokenRequest } from "../../test/oauth";
import { createApp } from "../app";
import { runWaitlist } from "../modules/waitlist/matching";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Awaited<ReturnType<typeof seedFixtures>>;
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "mcp_management" });
});
afterAll(async () => await t.close());
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
});

const range = {
  from: "2026-03-09T09:00:00.000Z",
  to: "2026-03-10T09:00:00.000Z",
};
const block = {
  startsAt: "2026-03-09T15:00:00.000Z",
  endsAt: "2026-03-09T16:00:00.000Z",
  reason: "private staff information",
};

test("the personal booking grant cannot create or cancel centre appointments", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const personal = (await tokenFor(t, owner, "mcp:read mcp:book")).tokens.access_token;
  const manager = (await tokenFor(t, owner, "operations:read schedule:write")).tokens.access_token;
  const input = {
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    staffId: f.anaId,
    startsAt: MONDAY_0900,
    professionalPreference: "specific",
    requestId: crypto.randomUUID(),
  };
  const refused = await callTool(t.app, personal, "create_appointment", input);
  expect(refused.data?.error?.code).toBe("forbidden");
  expect(refused.text).toContain("schedule:write");
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const created = await callTool(t.app, manager, "create_appointment", input);
  expect(created.isError, created.text).toBe(false);
  const visit = created.data?.appointment;
  expect(visit).toBeDefined();
  const { id, version } = visit;
  const preferences = await callTool(t.app, manager, "get_calendar", range);
  expect(preferences.data?.data?.appointments[0]?.serviceBadges?.[0]).toMatchObject({
    requested: true,
  });
  expect(
    (await callTool(t.app, personal, "cancel_appointment", { appointmentId: id, version })).data
      ?.error?.code,
  ).toBe("forbidden");
  expect(
    (await callTool(t.app, manager, "cancel_appointment", { appointmentId: id })).data?.error?.code,
  ).toBe("validation_error");
  expect(
    (
      await callTool(t.app, manager, "cancel_appointment", {
        appointmentId: id,
        version: version + 1,
      })
    ).data?.error?.code,
  ).toBe("version_conflict");
  const cancelled = await callTool(t.app, manager, "cancel_appointment", {
    appointmentId: id,
    version,
  });
  expect(cancelled.data?.appointment?.status).toBe("cancelled");
});

test("the Booksy consultation copy refuses MCP mutations even with a valid management token", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const { tokens } = await tokenFor(t, owner, "operations:read schedule:write");
  const preview = createApp({
    db: t.db,
    valkey: t.valkey.client,
    config: t.config,
    booksyNativePreview: {
      system: "booksy",
      capturedAt: "2026-03-01T12:00:00.000Z",
      fromDate: "2026-03-09",
      throughDate: "2026-03-12",
      readOnly: true,
    },
  });
  try {
    const blocked = await callTool(preview, tokens.access_token, "create_time_off", {
      id: f.anaId,
      body: block,
    });
    expect(blocked.res.status).toBe(403);
    expect(await t.db.select().from(timeOff)).toHaveLength(0);
  } finally {
    await preview.shutdown();
  }
});

test("management uses the granted scope and regular calendar permissions", async () => {
  const staff = await actor(t, "staff", "pro@example.com", {
    staffProfileId: f.anaId,
  });
  const { tokens } = await tokenFor(t, staff, "mcp:read operations:read schedule:write");
  expect(await listTools(t.app, tokens.access_token)).toContain("create_time_off");
  expect(await listTools(t.app, tokens.access_token)).not.toContain("replace_working_hours");
  const forbidden = await callTool(t.app, tokens.access_token, "create_time_off", {
    id: f.beaId,
    body: block,
  });
  expect(forbidden.data?.error?.code).toBe("forbidden");
  expect(await t.db.select().from(timeOff)).toHaveLength(0);
  const created = await callTool(t.app, tokens.access_token, "create_time_off", {
    id: f.anaId,
    body: block,
  });
  expect(created.data?.data?.timeOff?.staffId).toBe(f.anaId);
  expect(created.text).not.toContain(block.reason);
  const listed = await callTool(t.app, tokens.access_token, "list_time_off", {
    id: f.anaId,
    query: range,
  });
  expect(listed.data?.data?.timeOff).toHaveLength(1);
  const audit = await t.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "mcp.write_requested"));
  expect(
    audit.some(
      (row) => row.actorUserId === staff.userId && row.metadata.tool === "create_time_off",
    ),
  ).toBe(true);
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "restricted" })
    .where(eq(staffProfile.id, f.anaId));
  expect(await listTools(t.app, tokens.access_token)).not.toContain("create_time_off");
});

test("owner read tools expose bounded summaries, and a read-only grant cannot write", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const { tokens } = await tokenFor(t, owner, "mcp:read operations:read");
  const bearer = tokens.access_token;
  expect(await listTools(t.app, bearer)).not.toContain("create_time_off");
  expect(await listTools(t.app, bearer)).toContain("get_product");
  const attempted = await callTool(t.app, bearer, "create_time_off", {
    id: f.anaId,
    body: block,
  });
  expect(attempted.isError || attempted.rpcError !== null).toBe(true);
  expect(await t.db.select().from(timeOff)).toHaveLength(0);
  for (const name of [
    "list_clients",
    "list_catalog_services",
    "list_products",
    "list_stock_movements",
    "list_resources",
    "list_sales",
    "get_cash_session",
    "get_centre_settings",
    "list_waitlist",
    "list_benefit_plans",
    "list_passes",
    "list_gift_cards",
    "list_campaigns",
    "list_promotions",
    "get_loyalty_policy",
    "list_calendar_notices",
    "get_notification_stats",
    "get_whatsapp_settings",
  ]) {
    const result = await callTool(t.app, bearer, name, {});
    expect(result.rpcError, name).toBeNull();
    expect(result.text, name).not.toBe("");
    expect(result.isError, `${name}: ${result.text}`).toBe(false);
  }
});

test("MCP booking protection uses the reviewed policy generation and version", async () => {
  const owner = await actor(t, "owner", "policy-owner@example.com");
  const token = (await tokenFor(t, owner, "operations:read settings:write")).tokens.access_token;
  const read = await callTool(t.app, token, "get_booking_policy", {});
  expect(read.isError, read.text).toBe(false);
  const current = read.data?.data;
  expect(current?.generation).toBeString();
  expect(current?.policy.version).toBeGreaterThan(0);
  const reviewed = {
    generation: current?.generation,
    policy: { ...current?.policy, holdMinutes: 24 },
  };
  const saved = await callTool(t.app, token, "update_booking_policy", { body: reviewed });
  expect(saved.isError, saved.text).toBe(false);
  expect(saved.data?.data).toMatchObject({
    generation: current?.generation,
    policy: { holdMinutes: 24, version: current?.policy.version + 1 },
  });
  const stale = await callTool(t.app, token, "update_booking_policy", { body: reviewed });
  expect(stale.data?.error?.code).toBe("version_conflict");
});

test("waitlist offers retain calendar access checks, reviewed terms and safe replay", async () => {
  const owner = await actor(t, "owner", "offer-owner@example.com");
  const bea = await actor(t, "staff", "offer-bea@example.com", {
    staffProfileId: f.beaId,
  });
  const other = await actor(t, "client", "offer-client@example.com");
  const ownerToken = (await tokenFor(t, owner, "operations:read schedule:write settings:write"))
    .tokens.access_token;
  const staffToken = (await tokenFor(t, bea, "operations:read schedule:write")).tokens.access_token;
  const readToken = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  expect(
    (
      await callTool(t.app, ownerToken, "update_waitlist_policy", {
        enabled: true,
        offerMinutes: 30,
        version: 1,
      })
    ).isError,
  ).toBe(false);

  const create = async (clientId: string, fromTime: string, toTime: string) => {
    const joined = await callTool(t.app, ownerToken, "add_waitlist_entry", {
      clientId,
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      fromDate: MONDAY,
      toDate: MONDAY,
      fromTime,
      toTime,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(joined.isError, joined.text).toBe(false);
    return joined.data?.data.id as string;
  };
  const first = await create(f.clientId, "09:00", "10:00");
  const second = await create(other.clientId!, "10:00", "11:00");
  expect((await runWaitlist(t.db, { now: NOW })).offersCreated).toBe(2);
  const waitlist = await callTool(t.app, readToken, "list_waitlist", {});
  expect(waitlist.data?.data.entries).toHaveLength(2);
  expect(waitlist.data?.data.entries[0]).not.toHaveProperty("offer");
  const denied = await callTool(t.app, staffToken, "review_waitlist_offer", {
    id: first,
  });
  expect(denied.data?.error?.code).toBe("forbidden");
  expect(await listTools(t.app, readToken)).not.toContain("accept_waitlist_offer");

  const reviewed = await callTool(t.app, readToken, "review_waitlist_offer", {
    id: first,
  });
  expect(reviewed.isError, reviewed.text).toBe(false);
  const result = reviewed.data?.data;
  if (!result) throw new Error("The MCP server returned no offer review");
  const { entry, intake } = result;
  expect(entry.offer).toMatchObject({
    startsAt: MONDAY_0900,
    priceCents: 10000,
    staffId: f.anaId,
  });
  expect(intake).toMatchObject({ forms: [], readyResponses: [] });
  const body = {
    version: entry.version,
    offerId: entry.offer.id,
    expectedTotalCents: entry.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
    intakeReviewHash: intake.reviewHash,
  };
  const accept = (args: Record<string, unknown>) =>
    callTool(t.app, ownerToken, "accept_waitlist_offer", {
      id: first,
      body: args,
    });
  expect((await accept({ ...body, expectedTotalCents: 1 })).data?.error?.code).toBe(
    "version_conflict",
  );
  const waiver = await accept({
    ...body,
    protectionWaiverReason: "Use the team dashboard",
  });
  expect(waiver.isError || waiver.rpcError !== null).toBe(true);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const booked = await accept(body);
  expect(booked.isError, booked.text).toBe(false);
  expect(booked.data?.data.appointment).not.toHaveProperty("notes");
  expect((await accept(body)).data?.data.appointment.id).toBe(booked.data?.data.appointment.id);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  const pending = (await callTool(t.app, readToken, "review_waitlist_offer", { id: second })).data
    ?.data.entry;
  const requeued = await callTool(t.app, ownerToken, "requeue_waitlist_offer", {
    id: second,
    body: { version: pending.version, offerId: pending.offer.id },
  });
  expect(requeued.data?.data.state).toBe("waiting");
});

test("recurring appointments use a reviewed schedule and create each occurrence once", async () => {
  const owner = await actor(t, "owner", "series-owner@example.com");
  const readToken = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  const writeToken = (await tokenFor(t, owner, "schedule:write")).tokens.access_token;
  expect(await listTools(t.app, readToken)).not.toContain("create_appointment_series");
  const input = {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
    cadence: "weekly",
    interval: 1,
    count: 2,
  };
  const reviewed = await callTool(t.app, readToken, "preview_appointment_series", input);
  expect(reviewed.isError, reviewed.text).toBe(false);
  expect(reviewed.data?.data.occurrences).toHaveLength(2);
  const body = {
    ...input,
    reviewHash: reviewed.data?.data.reviewHash,
    idempotencyKey: crypto.randomUUID(),
  };
  const changed = await callTool(t.app, writeToken, "create_appointment_series", {
    ...body,
    count: 3,
  });
  expect(changed.data?.error?.code).toBe("version_conflict");
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const booked = await callTool(t.app, writeToken, "create_appointment_series", body);
  expect(booked.isError, booked.text).toBe(false);
  const replay = await callTool(t.app, writeToken, "create_appointment_series", body);
  expect(replay.data?.data.id).toBe(booked.data?.data.id);
  const series = await callTool(t.app, readToken, "get_appointment_series", {
    id: booked.data?.data.id,
  });
  expect(series.isError, series.text).toBe(false);
  expect(series.data?.data.appointments).toHaveLength(2);
  expect(series.data?.data.appointments[0]).not.toHaveProperty("notes");
  expect(await t.db.select().from(appointment)).toHaveLength(2);
});

test("rescheduling uses the appointment's saved services and calendar permissions", async () => {
  const owner = await actor(t, "owner", "reschedule-owner@example.com");
  const staff = await actor(t, "staff", "reschedule-staff@example.com", {
    staffProfileId: f.beaId,
  });
  const assigned = await actor(t, "staff", "reschedule-assigned@example.com", {
    staffProfileId: f.anaId,
  });
  const ownerToken = (await tokenFor(t, owner, "mcp:book operations:read schedule:write")).tokens
    .access_token;
  const staffToken = (await tokenFor(t, staff, "operations:read")).tokens.access_token;
  const assignedToken = (await tokenFor(t, assigned, "operations:read")).tokens.access_token;
  const booked = await callTool(t.app, ownerToken, "create_appointment", {
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    staffId: f.anaId,
    startsAt: MONDAY_0900,
    requestId: crypto.randomUUID(),
  });
  expect(booked.isError, booked.text).toBe(false);
  const [original] = await t.db.select().from(appointment);
  if (!original) throw new Error("Fixture appointment was not created");
  const input = {
    id: original.id,
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    date: MONDAY,
  };
  const denied = await callTool(t.app, staffToken, "find_reschedule_availability", input);
  expect(denied.data?.error?.code).toBe("forbidden");
  const own = await callTool(t.app, assignedToken, "find_reschedule_availability", {
    ...input,
    staffId: undefined,
  });
  expect(own.isError, own.text).toBe(false);
  expect(own.data?.data.slots.length).toBeGreaterThan(0);
  expect(new Set(own.data?.data.slots.map((slot: { staffId: string }) => slot.staffId))).toEqual(
    new Set([f.anaId]),
  );
  const differentServices = await callTool(t.app, ownerToken, "find_reschedule_availability", {
    ...input,
    serviceIds: [f.colorId],
  });
  expect(differentServices.data?.error?.code).toBe("validation_error");
  const slots = await callTool(t.app, ownerToken, "find_reschedule_availability", input);
  expect(slots.isError, slots.text).toBe(false);
  expect(slots.data?.data.slots).toContainEqual(
    expect.objectContaining({ startsAt: MONDAY_0900, staffId: f.anaId }),
  );
  const moved = await callTool(t.app, ownerToken, "update_appointment", {
    id: original.id,
    body: { startsAt: "2026-03-09T13:00:00.000Z", version: original.version },
  });
  expect(moved.isError, moved.text).toBe(false);
  expect(moved.data?.data).toMatchObject({ startsAt: "2026-03-09T13:00:00.000Z" });
});

test("imported price review requires the owner and explicit write consent", async () => {
  const owner = await actor(t, "owner", "billing-owner@example.com");
  const staff = await actor(t, "staff", "billing-staff@example.com", {
    staffProfileId: f.anaId,
  });
  const ownerToken = (await tokenFor(t, owner, "schedule:write operations:read billing:write"))
    .tokens.access_token;
  const readToken = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  const salesToken = (await tokenFor(t, owner, "sales:write")).tokens.access_token;
  const staffToken = (await tokenFor(t, staff, "operations:read billing:write")).tokens
    .access_token;
  const booked = await callTool(t.app, ownerToken, "create_appointment", {
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    staffId: f.anaId,
    startsAt: MONDAY_0900,
    requestId: crypto.randomUUID(),
  });
  expect(booked.isError, booked.text).toBe(false);
  const [original] = await t.db.select().from(appointment);
  if (!original) throw new Error("Fixture appointment was not created");
  const [line] = await t.db
    .update(appointmentService)
    .set({ sourceUnpriced: true, priceCents: 0, currency: "EUR" })
    .where(eq(appointmentService.appointmentId, original.id))
    .returning();
  if (!line) throw new Error("Fixture service was not created");

  const review = await callTool(t.app, readToken, "get_imported_price_review", { id: original.id });
  expect(review.data?.data).toMatchObject({
    appointmentVersion: original.version,
    lines: [{ id: line.id }],
  });
  const args = {
    id: original.id,
    body: {
      appointmentVersion: original.version,
      reference: "Original quote checked by the owner",
      lines: [{ id: line.id, amountCents: 3650 }],
    },
  };
  expect(await listTools(t.app, staffToken)).not.toContain("get_imported_price_review");
  for (const token of [readToken, salesToken, staffToken]) {
    const denied = await callTool(t.app, token, "record_imported_price_review", args);
    expect(denied.isError || denied.rpcError !== null).toBe(true);
  }
  expect(await t.db.select().from(appointmentService)).toMatchObject([
    { reviewedPriceCents: null },
  ]);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const saved = await callTool(t.app, ownerToken, "record_imported_price_review", args);
    expect(saved.data?.data, saved.text).toEqual({ ok: true });
    expect(saved.text).not.toContain(args.body.reference);
  }
  expect(await t.db.select().from(appointmentService)).toMatchObject([
    { priceCents: 0, sourceUnpriced: true, reviewedPriceCents: 3650 },
  ]);
  expect(await t.db.select().from(checkout)).toHaveLength(0);
});

test.each([
  { mode: "settlement", amountCents: 10000 },
  { mode: "partial_payment", amountCents: 3500 },
])(
  "imported $mode reconciliation is private, exclusive to the owner and safe to retry",
  async ({ mode, amountCents }) => {
    const owner = await actor(t, "owner", "booksy-owner@example.com");
    const staff = await actor(t, "staff", "booksy-staff@example.com", {
      staffProfileId: f.anaId,
    });
    const writeToken = (
      await tokenFor(t, owner, "schedule:write operations:read billing:write sales:write")
    ).tokens.access_token;
    const readToken = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
    const staffToken = (await tokenFor(t, staff, "operations:read billing:write")).tokens
      .access_token;
    const booked = await callTool(t.app, writeToken, "create_appointment", {
      clientId: f.clientId,
      serviceIds: [f.haircutId],
      staffId: f.anaId,
      startsAt: MONDAY_0900,
      requestId: crypto.randomUUID(),
    });
    expect(booked.isError, booked.text).toBe(false);
    const [booking] = await t.db.select().from(appointment);
    if (!booking) throw new Error("Fixture appointment was not created");
    await t.db
      .update(appointmentService)
      .set({ priceCents: 10000, currency: "EUR" })
      .where(eq(appointmentService.appointmentId, booking.id));
    await t.db.insert(appointmentContext).values({
      appointmentId: booking.id,
      servicePosition: 0,
      source: "booksy",
      sourceRef: "synthetic-mcp-reconciliation",
      invoiced: true,
    });

    const get = `get_imported_${mode}`;
    const record = `record_imported_${mode}`;
    const lookup = { id: booking.id };
    const args = {
      ...lookup,
      body: {
        appointmentVersion: booking.version,
        amountCents,
        reference: "Private Booksy evidence",
      },
    };
    const preview = await callTool(t.app, readToken, get, lookup);
    expect(preview.data?.data, preview.text).toEqual({
      appointmentVersion: booking.version,
      ...(mode === "settlement" ? { settlement: null } : { originalTotalCents: 10000 }),
    });
    expect(await listTools(t.app, staffToken)).not.toContain(get);
    expect(await listTools(t.app, readToken)).not.toContain(record);
    for (const token of [readToken, staffToken]) {
      const denied = await callTool(t.app, token, record, args);
      expect(denied.isError || denied.rpcError !== null).toBe(true);
    }
    expect((await callTool(t.app, readToken, get, lookup)).data?.data).toEqual(preview.data?.data);

    const results = await Promise.all(
      Array.from({ length: 2 }, () => callTool(t.app, writeToken, record, args)),
    );
    for (const result of [...results, await callTool(t.app, readToken, get, lookup)]) {
      expect(result.data?.data, result.text).toEqual({
        appointmentVersion: booking.version + 1,
        ...(mode === "settlement"
          ? { settlement: { amountCents, recordedAt: expect.any(String) } }
          : { externalBalance: { paidInBooksyCents: amountCents, dueInCitameCents: 6500 } }),
      });
      expect(result.text).not.toContain(args.body.reference);
    }
    expect(await t.db.select().from(checkout)).toHaveLength(0);
    const draft = await callTool(t.app, writeToken, "create_checkout_draft", {
      body: { appointmentId: booking.id, idempotencyKey: crypto.randomUUID() },
    });
    if (mode === "settlement") {
      expect(draft.data?.error?.code, draft.text).toBe("invalid_state");
      expect(await t.db.select().from(checkout)).toHaveLength(0);
    } else {
      expect(draft.data?.data, draft.text).toMatchObject({
        totalCents: 6500,
        paidCents: 0,
        balanceCents: 6500,
      });
    }
  },
);

test("appointment notices respect calendar ownership and archive only for the signed-in user", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const ana = await actor(t, "staff", "ana@example.com", {
    staffProfileId: f.anaId,
  });
  const bea = await actor(t, "staff", "bea@example.com", {
    staffProfileId: f.beaId,
  });
  const access = async (user: typeof owner, scopes: string) =>
    (await tokenFor(t, user, scopes)).tokens.access_token;
  const ownerToken = await access(owner, "schedule:write operations:read");
  const anaToken = await access(ana, "operations:read schedule:write");
  const beaToken = await access(bea, "operations:read schedule:write");
  const created = await callTool(t.app, ownerToken, "create_appointment", {
    staffId: f.anaId,
    clientId: f.clientId,
    serviceIds: [f.haircutId],
    startsAt: MONDAY_0900,
    requestId: crypto.randomUUID(),
    notes: "private note in the appointment",
  });
  expect(created.isError, created.text).toBe(false);
  const inbox = (token: string, archived = false) =>
    callTool(t.app, token, "list_calendar_notices", { archived });
  const received = await inbox(anaToken);
  expect(received.data?.data?.entries).toHaveLength(1);
  expect(received.text).not.toContain("private note in the appointment");
  expect((await inbox(beaToken)).data?.data?.entries).toHaveLength(0);
  const archive = (token: string, archived: boolean) =>
    callTool(t.app, token, "set_calendar_notices_archived", {
      ids: [received.data?.data?.entries[0].id],
      archived,
    });
  expect((await archive(beaToken, true)).data?.error?.code).toBe("forbidden");
  expect((await archive(anaToken, true)).data?.data).toEqual({ ok: true });
  expect((await inbox(anaToken)).data?.data?.entries).toHaveLength(0);
  expect((await inbox(ownerToken)).data?.data?.entries).toHaveLength(1);
  expect((await inbox(anaToken, true)).data?.data?.entries).toHaveLength(1);
  expect((await archive(anaToken, false)).data?.data).toEqual({ ok: true });
  expect((await inbox(anaToken)).data?.data?.entries).toHaveLength(1);
});

test("loyalty and promotions require explicit write scopes and reuse versions and replay rules", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const reader = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  const writer = (await tokenFor(t, owner, "operations:read catalog:write settings:write")).tokens
    .access_token;
  const readerTools = await listTools(t.app, reader);
  expect(readerTools).not.toContain("update_loyalty_policy");
  expect(readerTools).not.toContain("create_promotion");
  const loyalty = await callTool(t.app, reader, "get_client_loyalty", {
    id: f.clientId,
  });
  expect(loyalty.data?.data?.availablePoints).toBe(0);
  const policy = await callTool(t.app, reader, "get_loyalty_policy", {});
  const terms = { ...policy.data?.data, enabled: true };
  const changed = await callTool(t.app, writer, "update_loyalty_policy", terms);
  expect(changed.data?.data?.version).toBe(2);
  const stale = await callTool(t.app, writer, "update_loyalty_policy", terms);
  expect(stale.data?.error?.code).toBe("version_conflict");

  const promo = {
    code: "WELCOME10",
    name: "Welcome",
    kind: "percent",
    value: 1000,
    active: true,
  };
  const created = await callTool(t.app, writer, "create_promotion", promo);
  expect(created.isError, created.text).toBe(false);
  const replay = await callTool(t.app, writer, "create_promotion", promo);
  expect(replay.data?.data?.id).toBe(created.data?.data?.id);
  const listed = await callTool(t.app, reader, "list_promotions", {
    search: "welcome",
  });
  expect(listed.data?.data?.promotions).toHaveLength(1);
});

test("catalogue tools preserve service order, require owner scopes and reject stale edits", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const reader = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  const writer = (await tokenFor(t, owner, "operations:read catalog:write")).tokens.access_token;
  const staff = await actor(t, "staff", "pro@example.com", { staffProfileId: f.anaId });
  const staffToken = (await tokenFor(t, staff, "operations:read catalog:write")).tokens
    .access_token;
  expect(await listTools(t.app, reader)).not.toContain("create_service_combination");
  expect(await listTools(t.app, staffToken)).not.toContain("list_service_combinations");
  expect(await listTools(t.app, staffToken)).not.toContain("configure_service");

  const request = {
    name: "Colour and cut",
    description: "Description stays out of MCP responses",
    serviceIds: [f.colorId, f.haircutId],
    active: true,
    idempotencyKey: crypto.randomUUID(),
  };
  const created = await callTool(t.app, writer, "create_service_combination", request);
  expect(created.isError, created.text).toBe(false);
  const combination = created.data?.data;
  expect(combination).toMatchObject({ serviceIds: request.serviceIds, version: 1, bookable: true });
  expect(created.text).not.toContain(request.description);
  const replay = await callTool(t.app, writer, "create_service_combination", request);
  expect(replay.data?.data?.id).toBe(combination.id);
  const { idempotencyKey: _, ...fields } = request;
  const edit = { id: combination.id, body: { ...fields, active: false, version: 1 } };
  expect(
    (await callTool(t.app, writer, "update_service_combination", edit)).data?.data,
  ).toMatchObject({ active: false, version: 2 });
  expect(
    (await callTool(t.app, writer, "update_service_combination", edit)).data?.error?.code,
  ).toBe("version_conflict");
  const list = await callTool(t.app, reader, "list_service_combinations", {});
  expect(list.data?.data?.combinations).toMatchObject([{ id: combination.id, active: false }]);

  const variant = await callTool(t.app, writer, "create_service", {
    name: "Long cut",
    durationMinutes: 75,
    priceCents: 3600,
    catalog: { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Long" },
  });
  expect(variant.isError, variant.text).toBe(false);
  const id = variant.data?.data?.id;
  const version = variant.data?.data?.version;
  const settings = {
    id,
    body: {
      version,
      service: { name: "Reviewed cut" },
      staffIds: [f.anaId],
      catalog: { kind: "variant", version, optionLabel: "Extra long" },
    },
  };
  const configured = await callTool(t.app, writer, "configure_service", settings);
  expect(configured.data?.data).toMatchObject({
    name: "Reviewed cut",
    staffIds: [f.anaId],
    catalog: { kind: "variant", parentServiceId: f.haircutId, optionLabel: "Extra long" },
  });
  expect((await callTool(t.app, writer, "configure_service", settings)).data?.error?.code).toBe(
    "version_conflict",
  );
});

test("staff capacity uses current versions and unpaid lookup accepts staff filters", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const { tokens } = await tokenFor(t, owner, "operations:read schedule:write");
  const bearer = tokens.access_token;
  const capacity = await callTool(t.app, bearer, "get_staff_capacity", {
    id: f.anaId,
  });
  expect(capacity.data?.data?.maxConcurrent).toBe(1);
  const changed = await callTool(t.app, bearer, "set_staff_capacity", {
    id: f.anaId,
    body: {
      version: capacity.data?.data?.version,
      maxConcurrent: 2,
      confirmed: true,
    },
  });
  expect(changed.data?.data?.maxConcurrent).toBe(2);
  const stale = await callTool(t.app, bearer, "set_staff_capacity", {
    id: f.anaId,
    body: {
      version: capacity.data?.data?.version,
      maxConcurrent: 3,
      confirmed: true,
    },
  });
  expect(stale.data?.error?.code).toBe("version_conflict");
  const unpaid = await callTool(t.app, bearer, "list_unpaid_appointments", {
    ...range,
    staffIds: f.anaId,
  });
  expect(unpaid.isError, unpaid.text).toBe(false);
  expect(unpaid.data?.data?.appointments).toBeArray();
  const calendar = await callTool(t.app, bearer, "get_calendar", {
    ...range,
    staffIds: f.anaId,
  });
  expect(calendar.isError, calendar.text).toBe(false);
  expect(calendar.data?.data?.staff).toEqual([expect.objectContaining({ id: f.anaId })]);
});

test("clients cannot elevate by requesting management scopes and reduced consent takes effect on the same token", async () => {
  const client = await actor(t, "client", "client@example.com");
  const clientGrant = await tokenFor(t, client, "mcp:read operations:read schedule:write");
  expect(await listTools(t.app, clientGrant.tokens.access_token)).not.toContain("list_clients");
  const owner = await actor(t, "owner", "owner@example.com");
  const grant = await tokenFor(t, owner, "mcp:read operations:read schedule:write");
  expect(await listTools(t.app, grant.tokens.access_token)).toContain("create_time_off");
  await t.db
    .update(oauthConsent)
    .set({ scopes: ["mcp:read", "operations:read"] })
    .where(eq(oauthConsent.clientId, grant.clientId));
  expect(await listTools(t.app, grant.tokens.access_token)).not.toContain("create_time_off");
});

test("revoking a connection invalidates access and refresh tokens without reviving the old grant on reconnect", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const scope = "mcp:read operations:read offline_access";
  const grant = await tokenFor(t, owner, scope);
  const list = await json(t.app, "/me/connections", "GET", undefined, owner.cookie);
  expect(await list.json()).toMatchObject({
    connections: [{ clientId: grant.clientId }],
  });
  const other = await actor(t, "client", "other@example.com");
  await json(t.app, `/me/connections/${grant.clientId}`, "DELETE", undefined, other.cookie);
  expect((await rpc(t.app, grant.tokens.access_token, "tools/list")).res.status).toBe(200);
  expect(
    (await json(t.app, `/me/connections/${grant.clientId}`, "DELETE", undefined, owner.cookie))
      .status,
  ).toBe(204);
  expect((await rpc(t.app, grant.tokens.access_token, "tools/list")).res.status).toBe(401);
  const refresh = await tokenRequest(t.app, {
    grant_type: "refresh_token",
    client_id: grant.clientId,
    refresh_token: grant.tokens.refresh_token!,
  });
  expect(refresh.res.status).toBe(400);
  const renewed = await tokenFor(t, owner, scope, grant.clientId);
  expect((await rpc(t.app, renewed.tokens.access_token, "tools/list")).res.status).toBe(200);
  expect((await rpc(t.app, grant.tokens.access_token, "tools/list")).res.status).toBe(401);
});

test("cash and stock mutations keep the web rules and replay keys", async () => {
  const owner = await actor(t, "owner", "owner@example.com");
  const { tokens } = await tokenFor(t, owner, "operations:read stock:write sales:write cash:write");
  const token = tokens.access_token;
  const challenge = await rpc(t.app, token, "tools/list");
  expect(challenge.res.headers.get("cache-control")).toBe("no-store");
  const sessionId = crypto.randomUUID();
  const opened = await callTool(t.app, token, "open_cash_session", {
    sessionId,
    openingCents: 500,
  });
  expect(opened.data?.data?.id).toBe(sessionId);
  const reader = (await tokenFor(t, owner, "operations:read")).tokens.access_token;
  expect(await listTools(t.app, reader)).not.toContain("record_cash_movement");
  const movement = {
    sessionId,
    kind: "deposit",
    amountCents: 200,
    reason: "Private register note",
    idempotencyKey: "cash-management-movement",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const adjusted = await callTool(t.app, token, "record_cash_movement", movement);
    expect(adjusted.data?.data?.expectedCents).toBe(700);
    expect(adjusted.text).not.toContain(movement.reason);
  }
  const created = await callTool(t.app, token, "create_checkout_draft", {
    body: {
      lines: [
        {
          kind: "custom",
          description: "Fixture item",
          quantity: 1,
          unitAmountCents: 1000,
        },
      ],
      idempotencyKey: "draft-management-key",
    },
  });
  const id: string = created.data?.data?.id;
  expect(id).toBeString();
  const abandoned = await callTool(t.app, token, "create_checkout_draft", {
    body: {
      lines: [{ kind: "custom", description: "Abandoned sale", quantity: 1, unitAmountCents: 200 }],
      idempotencyKey: "abandoned-management-key",
    },
  });
  const abandonedId: string = abandoned.data?.data?.id;
  const cashOnly = (await tokenFor(t, owner, "cash:write")).tokens.access_token;
  const denied = await callTool(t.app, cashOnly, "void_checkout_draft", { id: abandonedId });
  expect(denied.isError || denied.rpcError !== null).toBe(true);
  for (let attempt = 0; attempt < 2; attempt++) {
    const voided = await callTool(t.app, token, "void_checkout_draft", { id: abandonedId });
    expect(voided.data?.data?.status).toBe("void");
  }
  const payment = {
    id,
    body: {
      method: "cash",
      amountCents: 1000,
      idempotencyKey: "payment-management-key",
    },
  };
  const redirect = await callTool(t.app, token, "record_received_payment", {
    ...payment,
    body: { ...payment.body, method: "redsys_card" },
  });
  expect(redirect.isError || redirect.rpcError !== null).toBe(true);
  const paid = await callTool(t.app, token, "record_received_payment", payment);
  const replay = await callTool(t.app, token, "record_received_payment", payment);
  expect(paid.data?.data?.payment?.status).toBe("succeeded");
  expect(replay.data?.data?.payment?.id).toBe(paid.data?.data?.payment?.id);
  const paidVoid = await callTool(t.app, token, "void_checkout_draft", { id });
  expect(paidVoid.data?.error?.code).toBe("invalid_state");
  const staleCash = await callTool(t.app, token, "close_cash_session", {
    id: sessionId,
    body: { countedCents: 1700, reviewedExpectedCents: 1500 },
  });
  expect(staleCash.data?.error?.code).toBe("version_conflict");
  const closed = await callTool(t.app, token, "close_cash_session", {
    id: sessionId,
    body: { countedCents: 1700, reviewedExpectedCents: 1700 },
  });
  expect(closed.data?.data).toMatchObject({
    countedCents: 1700,
    differenceCents: 0,
  });

  const item = await callTool(t.app, token, "create_product", {
    name: "Synthetic product",
    priceCents: 1000,
    openingStock: 3,
    packageContent: { quantity: "12,50", unit: "ml" },
    idempotencyKey: "product-management-key",
  });
  expect(item.data?.data).toMatchObject({
    stockOnHand: 3,
    packageContent: { quantity: "12.5", unit: "ml" },
  });
  const reviewed = await callTool(t.app, token, "get_product", { id: item.data?.data?.id });
  expect(reviewed.data?.data?.inventoryGeneration).toEqual(expect.any(String));
  const received = {
    id: item.data?.data?.id,
    body: {
      kind: "receive",
      quantity: 4,
      reason: "Synthetic receipt",
      version: reviewed.data?.data?.version,
      generation: reviewed.data?.data?.inventoryGeneration,
      idempotencyKey: "movement-management-key",
    },
  };
  expect(
    (await callTool(t.app, token, "record_stock_movement", received)).data?.data?.stockOnHand,
  ).toBe(7);
  expect(
    (await callTool(t.app, token, "record_stock_movement", received)).data?.data?.stockOnHand,
  ).toBe(7);
});

test("benefit sales keep payment pending, support retries and withhold gift-card credentials", async () => {
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.haircutId));
  const owner = await actor(t, "owner", "owner@example.com");
  const token = (await tokenFor(t, owner, "operations:read catalog:write sales:write")).tokens
    .access_token;
  const plan = await callTool(t.app, token, "create_benefit_plan", {
    name: "Synthetic package",
    kind: "package",
    priceCents: 14000,
    includedUses: 2,
    serviceIds: [f.haircutId],
    validityDays: 90,
    idempotencyKey: "mcp-package-plan",
  });
  expect(plan.isError, plan.text).toBe(false);
  const saleInput = {
    clientId: f.clientId,
    planId: plan.data?.data.id,
    planVersion: plan.data?.data.version,
    idempotencyKey: "mcp-package-sale",
  };
  const automatic = await callTool(t.app, token, "create_pass_sale_draft", {
    ...saleInput,
    renewalMode: "automatic",
  });
  expect(automatic.isError || automatic.rpcError !== null).toBe(true);
  const stale = await callTool(t.app, token, "create_pass_sale_draft", {
    ...saleInput,
    planVersion: saleInput.planVersion + 1,
  });
  expect(stale.data?.error?.code).toBe("version_conflict");
  const sale = await callTool(t.app, token, "create_pass_sale_draft", saleInput);
  expect(sale.data?.data).toMatchObject({
    pass: { status: "pending", renewalMode: "manual" },
    checkout: { status: "open", paidCents: 0 },
  });
  const id = sale.data?.data.pass.id;
  const replay = await callTool(t.app, token, "create_pass_sale_draft", saleInput);
  expect(replay.data?.data.pass.id).toBe(id);
  expect((await callTool(t.app, token, "get_pass", { id })).data?.data.id).toBe(id);
  expect(
    (await callTool(t.app, token, "list_pass_periods", { id })).data?.data.periods,
  ).toHaveLength(1);

  const giftInput = {
    amountCents: 3000,
    buyerClientId: f.clientId,
    idempotencyKey: "mcp-gift-sale",
  };
  const saleGift = await callTool(t.app, token, "create_gift_card_sale_draft", giftInput);
  expect(saleGift.data?.data).toMatchObject({
    card: { status: "pending", amountCents: 3000, availableCents: 0 },
    checkout: { status: "open", paidCents: 0 },
  });
  const giftId = saleGift.data?.data.card.id;
  const giftReplay = await callTool(t.app, token, "create_gift_card_sale_draft", giftInput);
  expect(giftReplay.data?.data.card.id).toBe(giftId);
  const gift = await callTool(t.app, token, "get_gift_card", { id: giftId });
  expect(gift.data?.data.id).toBe(giftId);
  expect(gift.data?.data).not.toHaveProperty("code");
  expect(gift.data?.data).not.toHaveProperty("codeRevision");
  expect(
    (await callTool(t.app, token, "list_gift_card_movements", { id: giftId })).data?.data.movements,
  ).toEqual([]);
});

test("commission operations require explicit write consent and respect staff access", async () => {
  await t.db.update(service).set({ currency: "EUR" }).where(eq(service.id, f.haircutId));
  const owner = await actor(t, "owner", "owner@example.com");
  const professional = await actor(t, "staff", "commission@example.com", {
    staffProfileId: f.anaId,
  });
  const readToken = (await tokenFor(t, owner, "operations:read settings:write")).tokens
    .access_token;
  const staffToken = (await tokenFor(t, professional, "operations:read commissions:write")).tokens
    .access_token;
  const ownerToken = (
    await tokenFor(t, owner, "operations:read commissions:write sales:write cash:write")
  ).tokens.access_token;
  for (const token of [readToken, staffToken]) {
    const tools = await listTools(t.app, token);
    expect(tools).not.toContain("update_commission_policy");
    expect(tools).not.toContain("record_commission_payout");
  }
  const update = {
    id: f.anaId,
    body: { serviceBasisPoints: 2500, productBasisPoints: 500, version: null },
  };
  const policy = await callTool(t.app, ownerToken, "update_commission_policy", update);
  expect(policy.data?.data).toMatchObject({ staffId: f.anaId, version: 1 });
  expect(
    (await callTool(t.app, ownerToken, "update_commission_policy", update)).data?.error?.code,
  ).toBe("version_conflict");
  expect(
    (await callTool(t.app, staffToken, "get_commission_policy", { id: f.anaId })).data?.data
      .serviceBasisPoints,
  ).toBe(2500);
  expect(
    (await callTool(t.app, staffToken, "get_commission_statement", { id: f.beaId })).data?.error
      ?.code,
  ).toBe("forbidden");
  expect(
    (await callTool(t.app, ownerToken, "get_commission_statement", { id: f.beaId })).data?.data
      .outstandingCents,
  ).toBe(0);
  const payoutInput = {
    id: f.anaId,
    body: { amountCents: 100, reference: "Synthetic transfer", idempotencyKey: "mcp-payout" },
  };
  const unavailable = await callTool(t.app, ownerToken, "record_commission_payout", payoutInput);
  expect(unavailable.data?.error?.code).toBe("invalid_state");

  const sold = await callTool(t.app, ownerToken, "create_checkout_draft", {
    body: {
      staffId: f.anaId,
      lines: [{ kind: "service", serviceId: f.haircutId, quantity: 1 }],
      idempotencyKey: "mcp-commission-sale",
    },
  });
  const paid = await callTool(t.app, ownerToken, "record_received_payment", {
    id: sold.data?.data.id,
    body: { method: "external_card", amountCents: 10000, idempotencyKey: "mcp-commission-tender" },
  });
  expect(paid.data?.data.payment.status).toBe("succeeded");
  const payout = await callTool(t.app, ownerToken, "record_commission_payout", payoutInput);
  expect(payout.data?.data).toMatchObject({ amountCents: 100, staffId: f.anaId });
  expect(payout.text).not.toContain(payoutInput.body.reference);
  const replay = await callTool(t.app, ownerToken, "record_commission_payout", payoutInput);
  expect(replay.data?.data.id).toBe(payout.data?.data.id);
  const statement = await callTool(t.app, staffToken, "get_commission_statement", {
    id: f.anaId,
  });
  expect(statement.data?.data).toMatchObject({ paidCents: 100, outstandingCents: 2400 });
  expect(statement.text).not.toContain(payoutInput.body.reference);
});
