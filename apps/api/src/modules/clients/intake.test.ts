import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  appointmentSeriesSchema,
  intakeRequirementsSchema,
  intakeSubmissionSchema,
} from "@sob/contracts";
import {
  appointment,
  auditLog,
  clientProfile,
  intakeAppointment,
  intakeForm,
  intakeRevision,
  intakeSubmission,
  pgErrorCode,
  service,
  staffProfile,
  user,
} from "@sob/db";
import { eq, sql } from "drizzle-orm";
import {
  type Actor,
  actor,
  type Fixtures,
  json,
  NOW,
  seedFixtures,
  setupApiTest,
} from "../../../test/helpers";
import { callTool, tokenFor } from "../../../test/oauth";
import { loadPrincipal } from "../../auth/principal";
import { lockScheduling, type Tx } from "../../tx";
import { getBookableServices } from "../services/service";
import { runWaitlist } from "../waitlist/matching";
import { submitIntakeResponse } from "./intake";

let t: Awaited<ReturnType<typeof setupApiTest>>;
let f: Fixtures;
let owner: Actor;
let customer: Actor;
const QUESTION = "0198f5a0-7b1c-7000-8000-000000000001";
beforeAll(async () => {
  t = await setupApiTest({ dbSuffix: "intake_forms" });
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.reset();
  f = await seedFixtures(t.db);
  owner = await actor(t, "owner", "owner@intake.test");
  customer = await actor(t, "client", "client@intake.test");
});
const call = (path: string, method = "GET", body?: unknown, who = owner) =>
  json(t.app, path, method, body, who.cookie);
const definition = () => ({
  title: "Visit preferences",
  description: "Tell us your preferences for this visit.",
  fields: [{ id: QUESTION, kind: "text", label: "Your preferences", required: true }],
  allServices: false,
  serviceIds: [f.haircutId],
  requiredAtBooking: false,
  allowTeamResponses: false,
});
async function createDraft(changes: Record<string, unknown> = {}) {
  const response = await call("/admin/intake-forms", "POST", {
    idempotencyKey: crypto.randomUUID(),
    definition: { ...definition(), ...changes },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return response.json() as Promise<{
    id: string;
    version: number;
    active: boolean;
    published: null | {
      id: string;
      number: number;
      definition: { title: string; fields: { label: string }[] };
    };
  }>;
}
async function publish(changes: Record<string, unknown> = {}) {
  const draft = await createDraft(changes);
  expect(draft.published).toBeNull();
  expect(draft.active).toBe(false);
  const response = await call(`/admin/intake-forms/${draft.id}/publish`, "POST", {
    version: draft.version,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  const form = (await response.json()) as Awaited<ReturnType<typeof createDraft>>;
  if (!form.published) throw new Error("Missing revision");
  return { ...form, published: form.published };
}
test("draft creation is idempotent, unpublished drafts are private and only managers can administer them", async () => {
  const input = { idempotencyKey: crypto.randomUUID(), definition: definition() };
  const responses = await Promise.all([
    call("/admin/intake-forms", "POST", input),
    call("/admin/intake-forms", "POST", input),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  const first = await responses[0]?.json();
  expect(await responses[1]?.json()).toEqual(first);
  const requirements = await call(
    `/intake/requirements?serviceIds=${f.haircutId}`,
    "GET",
    undefined,
    customer,
  );
  expect(requirements.status).toBe(200);
  expect(await requirements.json()).toMatchObject({ forms: [] });
  const professional = await actor(t, "staff", "professional@intake.test");
  for (const who of [customer, professional]) {
    expect((await call("/admin/intake-forms", "GET", undefined, who)).status).toBe(403);
    expect((await call("/admin/intake-forms", "POST", input, who)).status).toBe(403);
  }
  if (!professional.staffId) throw new Error("Missing staff fixture");
  await t.db
    .update(staffProfile)
    .set({ accessPreset: "manager" })
    .where(eq(staffProfile.id, professional.staffId));
  expect((await call("/admin/intake-forms", "GET", undefined, professional)).status).toBe(200);
});

test("publishing freezes versions and draft edits cannot change the questions already answered", async () => {
  const form = await publish();
  const submitted = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Private original answer" },
    },
    customer,
  );
  expect(submitted.status, await submitted.clone().text()).toBe(201);
  const submission = (await submitted.json()) as { id: string };
  const updated = await call(`/admin/intake-forms/${form.id}`, "PUT", {
    version: form.version,
    definition: {
      ...definition(),
      title: "Changed draft",
      fields: [{ id: QUESTION, kind: "text", label: "Changed question", required: true }],
    },
  });
  expect(updated.status).toBe(200);
  expect(
    (await call(`/admin/intake-forms/${form.id}/publish`, "POST", { version: form.version }))
      .status,
  ).toBe(409);
  const current = (await updated.json()) as { version: number };
  expect(
    (await call(`/admin/intake-forms/${form.id}/publish`, "POST", { version: current.version }))
      .status,
  ).toBe(200);
  const detail = await call(`/intake/submissions/${submission.id}`, "GET", undefined, customer);
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toContain("no-store");
  expect(await detail.json()).toMatchObject({
    answers: { [QUESTION]: "Private original answer" },
    revision: {
      id: form.published.id,
      number: 1,
      definition: { title: "Visit preferences", fields: [{ label: "Your preferences" }] },
    },
  });
});

async function rejectsImmutable(work: PromiseLike<unknown>) {
  let rejected = false;
  try {
    await work;
  } catch (error) {
    rejected = true;
    expect(pgErrorCode(error)).toBe("23514");
  }
  expect(rejected).toBe(true);
}

test("published text and recorded answers cannot be rewritten or silently reattributed in the database", async () => {
  const form = await publish();
  const response = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Private immutable answer" },
    },
    customer,
  );
  expect(response.status).toBe(201);
  const submitted = (await response.json()) as { id: string };
  await rejectsImmutable(
    t.db
      .update(intakeRevision)
      .set({ title: "Rewritten" })
      .where(eq(intakeRevision.id, form.published.id)),
  );
  await rejectsImmutable(
    t.db.delete(intakeRevision).where(eq(intakeRevision.id, form.published.id)),
  );
  await rejectsImmutable(
    t.db
      .update(intakeSubmission)
      .set({ answers: { [QUESTION]: "Rewritten" } })
      .where(eq(intakeSubmission.id, submitted.id)),
  );
  await rejectsImmutable(
    t.db
      .update(intakeSubmission)
      .set({ clientId: f.clientId })
      .where(eq(intakeSubmission.id, submitted.id)),
  );
  await rejectsImmutable(
    t.db.delete(intakeSubmission).where(eq(intakeSubmission.id, submitted.id)),
  );
  const other = await publish({ title: "Another form" });
  await rejectsImmutable(
    t.db
      .update(intakeForm)
      .set({ currentRevisionId: other.published.id })
      .where(eq(intakeForm.id, form.id)),
  );
  await t.db.delete(user).where(eq(user.id, customer.userId));
  expect(
    (await t.db.select().from(intakeSubmission).where(eq(intakeSubmission.id, submitted.id)))[0]
      ?.createdBy,
  ).toBeNull();
  const logs = await t.db.select().from(auditLog);
  expect(JSON.stringify(logs)).not.toContain("Private immutable answer");
});

test("another customer cannot discover answers, summaries omit private content and archiving preserves history", async () => {
  const form = await publish();
  const response = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Private historical answer" },
    },
    customer,
  );
  const submission = (await response.json()) as { id: string };
  const other = await actor(t, "client", "another@intake.test");
  expect((await call(`/intake/submissions/${submission.id}`, "GET", undefined, other)).status).toBe(
    404,
  );
  const summary = await call("/me/intake", "GET", undefined, customer);
  expect(summary.status).toBe(200);
  expect(await summary.text()).not.toContain("Private historical answer");
  expect(
    (await call(`/admin/intake-forms/${form.id}/archive`, "POST", { version: form.version }))
      .status,
  ).toBe(200);
  expect(
    await (
      await call(`/intake/requirements?serviceIds=${f.haircutId}`, "GET", undefined, customer)
    ).json(),
  ).toMatchObject({ forms: [] });
  expect(
    (await call(`/intake/submissions/${submission.id}`, "GET", undefined, customer)).status,
  ).toBe(200);
  const stale = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "New answer" },
    },
    customer,
  );
  expect(stale.status).toBe(409);
});

test("answers require the current published revision, explicit confirmation and the frozen field types", async () => {
  const form = await publish();
  const input = {
    revisionId: form.published.id,
    idempotencyKey: crypto.randomUUID(),
    confirmation: true,
    answers: { [QUESTION]: "Original" },
  };
  expect(
    (await call("/me/intake", "POST", { ...input, confirmation: false }, customer)).status,
  ).toBe(400);
  expect(
    (await call("/me/intake", "POST", { ...input, answers: { [QUESTION]: false } }, customer))
      .status,
  ).toBe(400);
  const responses = await Promise.all([
    call("/me/intake", "POST", input, customer),
    call("/me/intake", "POST", input, customer),
  ]);
  expect(responses.map((r) => r.status)).toEqual([201, 201]);
  expect(await responses[1]?.json()).toEqual(await responses[0]?.json());
  expect(
    (await call("/me/intake", "POST", { ...input, answers: { [QUESTION]: "Changed" } }, customer))
      .status,
  ).toBe(409);
  const edit = await call(`/admin/intake-forms/${form.id}`, "PUT", {
    version: form.version,
    definition: { ...definition(), description: "Changed published terms" },
  });
  const version = ((await edit.json()) as { version: number }).version;
  expect((await call(`/admin/intake-forms/${form.id}/publish`, "POST", { version })).status).toBe(
    200,
  );
  expect(
    (await call("/me/intake", "POST", { ...input, idempotencyKey: crypto.randomUUID() }, customer))
      .status,
  ).toBe(409);
  // Recovery of the already saved statement does not manufacture another answer to new terms.
  expect((await call("/me/intake", "POST", input, customer)).status).toBe(201);
});

test("answer history is private and team-recorded answers need the published permission", async () => {
  const form = await publish();
  const input = {
    revisionId: form.published.id,
    idempotencyKey: crypto.randomUUID(),
    confirmation: true,
    answers: { [QUESTION]: "Private" },
  };
  expect((await call(`/admin/clients/${f.clientId}/intake`, "POST", input)).status).toBe(403);
  const response = await call("/me/intake", "POST", input, customer);
  expect(response.status).toBe(201);
  const submission = (await response.json()) as { id: string };
  const other = await actor(t, "client", "other@intake.test");
  expect((await call(`/intake/submissions/${submission.id}`, "GET", undefined, other)).status).toBe(
    404,
  );
  expect((await json(t.app, `/intake/submissions/${submission.id}`, "GET")).status).toBe(401);
  const history = await call("/me/intake", "GET", undefined, customer);
  expect(history.status).toBe(200);
  const text = await history.text();
  expect(text).not.toContain("Private");
  expect(text).not.toContain("answers");
  const paper = await publish({ allowTeamResponses: true });
  const recorded = await call(`/admin/clients/${f.clientId}/intake`, "POST", {
    ...input,
    revisionId: paper.published.id,
    idempotencyKey: crypto.randomUUID(),
  });
  expect(recorded.status).toBe(201);
  expect(await recorded.json()).toMatchObject({ source: "team" });
  await t.db
    .update(clientProfile)
    .set({ deletedAt: new Date() })
    .where(eq(clientProfile.id, f.clientId));
  expect((await call(`/admin/clients/${f.clientId}/intake`)).status).toBe(404);
});

const booking = () => ({
  id: Bun.randomUUIDv7(),
  staffId: f.anaId,
  serviceIds: [f.haircutId],
  startsAt: "2026-03-09T12:00:00.000Z",
});
test("reviewed desktop booking requires service quotes and explicit permission to reuse a saved response", async () => {
  const form = await publish({ requiredAtBooking: true });
  const recorded = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Synthetic saved response" },
    },
    customer,
  );
  expect(recorded.status).toBe(201);
  const saved = intakeSubmissionSchema.parse(await recorded.json());
  const requirements = intakeRequirementsSchema.parse(
    await (
      await call(`/intake/requirements?serviceIds=${f.haircutId}&clientId=${customer.clientId}`)
    ).json(),
  );
  const [service] = await getBookableServices(t.db, [f.haircutId]);
  const path = "/appointments/desktop-booking";
  const request = {
    ...booking(),
    clientId: customer.clientId,
    intakeReviewHash: requirements.reviewHash,
    desktopGeneration: requirements.desktopGeneration,
  };
  expect((await call(path, "POST", request)).status).toBe(400);
  const quoted = { ...request, serviceQuotes: { [f.haircutId]: service?.quoteHash } };
  expect((await call(path, "POST", quoted, customer)).status).toBe(403);
  const oldGeneration = await call(path, "POST", {
    ...quoted,
    desktopGeneration: "earlier-history",
  });
  expect(oldGeneration.status).toBe(409);
  expect(await oldGeneration.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  const withoutChoice = await call(path, "POST", quoted);
  expect(withoutChoice.status).toBe(409);
  expect(await withoutChoice.json()).toMatchObject({ error: { code: "intake_required" } });
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const approved = { ...quoted, intakeSubmissionIds: [saved.id] };
  const created = await call(path, "POST", approved);
  expect(created.status, await created.clone().text()).toBe(201);
  expect((await call(path, "POST", approved)).status).toBe(201);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(1);
});
test("a required questionnaire gates booking and a recent client-completed response is linked without exposing answers", async () => {
  const form = await publish({ requiredAtBooking: true });
  const request = booking();
  const blocked = await call("/appointments", "POST", request, customer);
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({ error: { code: "intake_required" } });
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const response = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Private booking answer" },
    },
    customer,
  );
  expect(response.status).toBe(201);
  const statement = (await response.json()) as { id: string };
  const created = await call("/appointments", "POST", request, customer);
  expect(created.status, await created.clone().text()).toBe(201);
  expect(await created.text()).not.toContain("Private booking answer");
  const linked = await call(`/intake/submissions/${statement.id}`, "GET", undefined, customer);
  expect(await linked.json()).toMatchObject({ appointmentId: request.id });
});

test("inline answers and a new walk-in are atomic when the required question is invalid", async () => {
  const form = await publish({ requiredAtBooking: true, allowTeamResponses: true });
  const before = await t.db.select().from(clientProfile);
  const response = await call("/appointments", "POST", {
    ...booking(),
    client: { name: "Uncommitted walk-in" },
    intakeResponses: [
      { revisionId: form.published.id, confirmation: true, answers: { [QUESTION]: false } },
    ],
  });
  expect(response.status).toBe(400);
  expect(await t.db.select().from(clientProfile)).toHaveLength(before.length);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(0);
});

test("a booking retry cannot silently replace the answers originally confirmed for that intent", async () => {
  const form = await publish({ requiredAtBooking: true });
  const request = {
    ...booking(),
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "Originally confirmed" },
      },
    ],
  };
  expect((await call("/appointments", "POST", request, customer)).status).toBe(201);
  expect((await call("/appointments", "POST", request, customer)).status).toBe(201);
  const changed = await call(
    "/appointments",
    "POST",
    {
      ...request,
      intakeResponses: [
        { ...request.intakeResponses[0], answers: { [QUESTION]: "Different statement" } },
      ],
    },
    customer,
  );
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ error: { code: "booking_intent_conflict" } });
  expect(await t.db.select().from(appointment)).toHaveLength(1);
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(1);
  const omitted = await call(
    "/appointments",
    "POST",
    { ...request, intakeResponses: undefined },
    customer,
  );
  expect(omitted.status).toBe(409);
  expect(await omitted.json()).toMatchObject({ error: { code: "booking_intent_conflict" } });
});

test("explicit responses must belong to this client and match current, applicable reviewed terms", async () => {
  const form = await publish({ requiredAtBooking: true });
  const submitted = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Reviewed" },
    },
    customer,
  );
  const response = (await submitted.json()) as { id: string };
  const other = await actor(t, "client", "foreign@intake.test");
  const request = { ...booking(), intakeSubmissionIds: [response.id] };
  expect((await call("/appointments", "POST", request, other)).status).toBe(409);
  expect(
    (
      await call(
        "/appointments",
        "POST",
        { ...request, intakeReviewHash: "0".repeat(64) },
        customer,
      )
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const saved = await call("/appointments", "POST", request, customer);
  expect(saved.status).toBe(201);
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(1);
  // A new statement may be associated with a visit, but cannot be attached to someone else's.
  const foreign = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      appointmentId: request.id,
      answers: { [QUESTION]: "Foreign" },
    },
    other,
  );
  expect(foreign.status).toBe(404);
  const correction = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      appointmentId: request.id,
      answers: { [QUESTION]: "New append-only statement" },
    },
    customer,
  );
  expect(correction.status).toBe(201);
  expect(await correction.json()).toMatchObject({ appointmentId: request.id });
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(2);
});

test("a recent response can accompany a reviewed series while published changes invalidate its preview", async () => {
  const form = await publish({ requiredAtBooking: true });
  const { id: _id, ...base } = booking();
  const input = {
    ...base,
    cadence: "weekly",
    interval: 1,
    count: 2,
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "For both reviewed dates" },
      },
    ],
  };
  const preview = await call("/appointments/series/preview", "POST", input, customer);
  expect(preview.status, await preview.clone().text()).toBe(200);
  const review = (await preview.json()) as { reviewHash: string };
  const request = { ...input, reviewHash: review.reviewHash, idempotencyKey: crypto.randomUUID() };
  const saved = await call("/appointments/series", "POST", request, customer);
  expect(saved.status, await saved.clone().text()).toBe(201);
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(2);
  expect((await call("/appointments/series", "POST", request, customer)).status).toBe(201);
  const edit = await call(`/admin/intake-forms/${form.id}`, "PUT", {
    version: form.version,
    definition: { ...definition(), requiredAtBooking: true, description: "Changed terms" },
  });
  const draft = (await edit.json()) as { version: number };
  expect(
    (await call(`/admin/intake-forms/${form.id}/publish`, "POST", { version: draft.version }))
      .status,
  ).toBe(200);
  const stale = await call(
    "/appointments/series",
    "POST",
    { ...request, idempotencyKey: crypto.randomUUID() },
    customer,
  );
  expect(stale.status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
});

test("Desktop reviews recurring visits with explicit forms and replays one complete series", async () => {
  await t.db.update(service).set({ currency: "EUR" });
  const form = await publish({ requiredAtBooking: true, allowTeamResponses: true });
  const requirements = intakeRequirementsSchema.parse(
    await (
      await call(`/intake/requirements?serviceIds=${f.haircutId}&clientId=${customer.clientId}`)
    ).json(),
  );
  const [quoted] = await getBookableServices(t.db, [f.haircutId]);
  const { id: _id, ...base } = booking();
  const input = {
    ...base,
    clientId: customer.clientId,
    cadence: "weekly",
    interval: 1,
    count: 2,
    serviceQuotes: { [f.haircutId]: quoted?.quoteHash },
    intakeReviewHash: requirements.reviewHash,
    desktopGeneration: requirements.desktopGeneration,
  };
  const path = "/appointments/desktop-series";
  expect((await call(`${path}/preview`, "POST", input, customer)).status).toBe(403);
  const stale = await call(`${path}/preview`, "POST", {
    ...input,
    desktopGeneration: "earlier-history",
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: { code: "sync_generation_changed" } });
  const preview = async (packet: object) => {
    const result = await call(`${path}/preview`, "POST", packet);
    expect(result.status, await result.clone().text()).toBe(200);
    const { reviewHash } = (await result.json()) as { reviewHash: string };
    return { reviewHash };
  };
  const incomplete = await preview(input);
  const appointmentIds = [crypto.randomUUID(), crypto.randomUUID()];
  expect(
    (
      await call(path, "POST", {
        ...input,
        ...incomplete,
        appointmentIds,
        idempotencyKey: crypto.randomUUID(),
      })
    ).status,
  ).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const enabled = await call("/admin/settings/booking-policy", "PUT", {
    enabled: true,
    depositKind: "percent",
    depositValue: 2500,
    holdMinutes: 15,
    cancellationWindowMinutes: 1440,
    lateCancellationBasisPoints: 2500,
    noShowBasisPoints: 5000,
    trustedExempt: true,
    version: 1,
  });
  expect(enabled.status, await enabled.clone().text()).toBe(200);
  const reviewed = {
    ...input,
    protectionWaiverReason: "Approved deposit waiver for the full series",
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "Reviewed for both dates" },
      },
    ],
  };
  const request = {
    ...reviewed,
    ...(await preview(reviewed)),
    appointmentIds,
    idempotencyKey: crypto.randomUUID(),
  };
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(0);
  const saved = await call(path, "POST", request);
  expect(saved.status, await saved.clone().text()).toBe(201);
  const replay = await call(path, "POST", request);
  expect(replay.status).toBe(201);
  const first = appointmentSeriesSchema.parse(await saved.json());
  const retried = appointmentSeriesSchema.parse(await replay.json());
  expect(retried.id).toBe(first.id);
  expect(first.appointments.map((a) => a.id)).toEqual(appointmentIds);
  expect(retried.appointments.map((a) => a.id)).toEqual(first.appointments.map((a) => a.id));
  expect(retried.appointments.map((a) => a.protection?.state)).toEqual(["waived", "waived"]);
  expect(await t.db.select().from(appointment)).toHaveLength(2);
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(2);
});

test("responses older than the review window or from the future cannot satisfy a current booking", async () => {
  const form = await publish({ requiredAtBooking: true });
  const principal = await loadPrincipal(t.db, customer.userId);
  if (!principal) throw new Error("Missing customer");
  for (const time of [new Date(NOW.getTime() - 25 * 3600000), new Date(NOW.getTime() + 1000)]) {
    const response = await submitIntakeResponse(
      t.db,
      customer.clientId ?? "",
      {
        revisionId: form.published.id,
        idempotencyKey: crypto.randomUUID(),
        confirmation: true,
        answers: { [QUESTION]: "Out of review window" },
      },
      principal,
      time,
    );
    expect(
      (
        await call(
          "/appointments",
          "POST",
          { ...booking(), intakeSubmissionIds: [response.id] },
          customer,
        )
      ).status,
    ).toBe(409);
  }
  const available = await call(
    `/intake/requirements?serviceIds=${f.haircutId}`,
    "GET",
    undefined,
    customer,
  );
  expect(await available.json()).toMatchObject({ readyResponses: [] });
  expect((await call("/appointments", "POST", booking(), customer)).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
});

test("requirements expose only this customer's recent response identities, never their answers or another profile", async () => {
  const form = await publish({ requiredAtBooking: true });
  const submitted = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Hidden private answer" },
    },
    customer,
  );
  const saved = (await submitted.json()) as { id: string };
  const own = await call(
    `/intake/requirements?serviceIds=${f.haircutId}`,
    "GET",
    undefined,
    customer,
  );
  const body = await own.json();
  expect(body).toMatchObject({ readyResponses: [{ id: saved.id, revisionId: form.published.id }] });
  expect(JSON.stringify(body)).not.toContain("Hidden private answer");
  const other = await actor(t, "client", "requirements-other@intake.test");
  expect(
    (
      await call(
        `/intake/requirements?serviceIds=${f.haircutId}&clientId=${customer.clientId}`,
        "GET",
        undefined,
        other,
      )
    ).status,
  ).toBe(403);
  const team = await call(
    `/intake/requirements?serviceIds=${f.haircutId}&clientId=${customer.clientId}`,
  );
  expect(await team.json()).toMatchObject({ readyResponses: [{ id: saved.id }] });
});

test("forms are checked again after waiting for publication and a rejected walk-in leaves no records", async () => {
  const form = await publish({ requiredAtBooking: true, allowTeamResponses: true });
  expect(
    (await call(`/admin/intake-forms/${form.id}/archive`, "POST", { version: form.version }))
      .status,
  ).toBe(200);
  const reviewed = await call(`/intake/requirements?serviceIds=${f.haircutId}`);
  const review = (await reviewed.json()) as { reviewHash: string };
  const before = await t.db.select().from(clientProfile);
  let release: () => void = () => {};
  let ready: () => void = () => {};
  let writer: Tx | undefined;
  const held = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const configuration = t.db.transaction(async (tx) => {
    writer = tx;
    await lockScheduling(tx);
    ready();
    await resume;
  });
  await held;
  const pending = Promise.resolve(
    call("/appointments", "POST", {
      ...booking(),
      client: { name: "Atomic unpublished walk-in" },
      intakeReviewHash: review.reviewHash,
    }),
  );
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
    if (!writer) throw new Error("Missing writer");
    await writer.update(intakeForm).set({ active: true }).where(eq(intakeForm.id, form.id));
  } finally {
    release();
    await configuration;
  }
  const response = await pending;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: { code: "intake_required" } });
  expect(await t.db.select().from(clientProfile)).toHaveLength(before.length);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(0);
});

test("a desktop booking without forms rechecks calendar permissions inside the scheduling lock", async () => {
  const staff = await actor(t, "staff", "revoked-operator@intake.test", {
    staffProfileId: f.anaId,
  });
  const [service] = await getBookableServices(t.db, [f.haircutId]);
  const requirements = intakeRequirementsSchema.parse(
    await (await call(`/intake/requirements?serviceIds=${f.haircutId}`)).json(),
  );
  expect(requirements.forms).toHaveLength(0);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const configuration = t.db.transaction(async (tx) => {
    await lockScheduling(tx);
    locked.resolve();
    await release.promise;
    await tx
      .update(staffProfile)
      .set({ accessPreset: "restricted" })
      .where(eq(staffProfile.id, f.anaId));
  });
  await locked.promise;
  const pending = Promise.resolve(
    call(
      "/appointments/desktop-booking",
      "POST",
      {
        ...booking(),
        serviceQuotes: { [f.haircutId]: service?.quoteHash },
        intakeReviewHash: requirements.reviewHash,
        desktopGeneration: requirements.desktopGeneration,
        client: { name: "Synthetic pending client" },
      },
      staff,
    ),
  );
  try {
    const deadline = Date.now() + 3000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await t.db.execute(
        sql`select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where locktype='advisory' and not granted and a.datname=current_database() limit 1`,
      );
      if (rows.length) {
        waiting = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(waiting).toBe(true);
  } finally {
    release.resolve();
    await configuration;
  }
  const rejected = await pending;
  expect(rejected.status, await rejected.clone().text()).toBe(403);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  expect(
    await t.db
      .select()
      .from(clientProfile)
      .where(eq(clientProfile.name, "Synthetic pending client")),
  ).toHaveLength(0);
});

test("accepting a held waitlist offer enforces and atomically records the required current answers", async () => {
  const form = await publish({ requiredAtBooking: true });
  expect(
    (await call("/admin/waitlist/policy", "PUT", { enabled: true, offerMinutes: 30, version: 1 }))
      .status,
  ).toBe(200);
  const joined = await call(
    "/me/waitlist",
    "POST",
    {
      staffId: f.anaId,
      serviceIds: [f.haircutId],
      fromDate: "2026-03-09",
      toDate: "2026-03-09",
      fromTime: "09:00",
      toTime: "10:00",
      idempotencyKey: crypto.randomUUID(),
    },
    customer,
  );
  expect(joined.status).toBe(201);
  const entry = (await joined.json()) as { id: string };
  await runWaitlist(t.db, { now: NOW });
  const listing = await call("/me/waitlist", "GET", undefined, customer);
  const offered = (
    (await listing.json()) as {
      entries: { version: number; offer: { id: string; priceCents: number } }[];
    }
  ).entries[0];
  if (!offered?.offer) throw new Error("Missing held offer");
  const request = {
    version: offered.version,
    offerId: offered.offer.id,
    expectedTotalCents: offered.offer.priceCents,
    idempotencyKey: crypto.randomUUID(),
  };
  const path = `/me/waitlist/${entry.id}/accept`;
  expect((await call(path, "POST", request, customer)).status).toBe(409);
  expect(await t.db.select().from(appointment)).toHaveLength(0);
  const answered = {
    ...request,
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "Offer reviewed" },
      },
    ],
  };
  const accepted = await call(path, "POST", answered, customer);
  expect(accepted.status, await accepted.clone().text()).toBe(201);
  expect((await call(path, "POST", answered, customer)).status).toBe(201);
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(1);
  expect(await t.db.select().from(intakeAppointment)).toHaveLength(1);
});

test("appointment-response associations cannot be deleted, rebound or attached to another client", async () => {
  const form = await publish({ requiredAtBooking: true });
  const input = {
    ...booking(),
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "Frozen association" },
      },
    ],
  };
  expect((await call("/appointments", "POST", input, customer)).status).toBe(201);
  const [link] = await t.db.select().from(intakeAppointment);
  if (!link) throw new Error("Missing association");
  await rejectsImmutable(
    t.db.delete(intakeAppointment).where(eq(intakeAppointment.appointmentId, input.id)),
  );
  await rejectsImmutable(
    t.db
      .update(intakeAppointment)
      .set({ createdAt: new Date(0) })
      .where(eq(intakeAppointment.appointmentId, input.id)),
  );
  const other = await actor(t, "client", "intake-association-other@example.invalid");
  const submitted = await call(
    "/me/intake",
    "POST",
    {
      revisionId: form.published.id,
      idempotencyKey: crypto.randomUUID(),
      confirmation: true,
      answers: { [QUESTION]: "Other client's statement" },
    },
    other,
  );
  const response = (await submitted.json()) as { id: string };
  await rejectsImmutable(
    t.db
      .insert(intakeAppointment)
      .values({ appointmentId: input.id, submissionId: response.id, createdBy: owner.userId }),
  );
  await t.db.delete(user).where(eq(user.id, customer.userId));
  expect((await t.db.select().from(intakeAppointment))[0]?.createdBy).toBeNull();
});

test("MCP cannot fabricate a required answer and may book only after the human completes it", async () => {
  const form = await publish({ requiredAtBooking: true });
  const { tokens } = await tokenFor(t, customer, "mcp:read mcp:book");
  const input = {
    staffId: f.anaId,
    serviceIds: [f.haircutId],
    startsAt: "2026-03-09T12:00:00.000Z",
    requestId: Bun.randomUUIDv7(),
    intakeResponses: [
      {
        revisionId: form.published.id,
        confirmation: true,
        answers: { [QUESTION]: "Untrusted agent statement" },
      },
    ],
  };
  const blocked = await callTool(t.app, tokens.access_token, "create_appointment", input);
  expect(blocked.isError).toBe(true);
  expect(blocked.data?.error.code).toBe("intake_required");
  expect(blocked.text).toContain("Never invent answers");
  expect(await t.db.select().from(intakeSubmission)).toHaveLength(0);
  expect(
    (
      await call(
        "/me/intake",
        "POST",
        {
          revisionId: form.published.id,
          idempotencyKey: crypto.randomUUID(),
          confirmation: true,
          answers: { [QUESTION]: "Human completed in private account" },
        },
        customer,
      )
    ).status,
  ).toBe(201);
  const saved = await callTool(t.app, tokens.access_token, "create_appointment", input);
  expect(saved.isError).toBe(false);
  expect(JSON.stringify(saved.data)).not.toContain("Human completed in private account");
  expect(
    (await callTool(t.app, tokens.access_token, "create_appointment", input)).data?.replayed,
  ).toBe(true);
  expect(await t.db.select().from(appointment)).toHaveLength(1);
});
