import {
  type ChangeStampCard,
  type IssueStampCard,
  type StampCard,
  type StampProgramInput,
  type StampProgramTerms,
  stampProgramTermsSchema,
} from "@sob/contracts";
import {
  appointmentService,
  type Database,
  retailProduct,
  service,
  stampCard,
  stampCardEvent,
  stampProgram,
} from "@sob/db";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission, requireRole } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientIdentityIds, clientRoot, lockClientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { rewardHash } from "./accounts";

type Card = typeof stampCard.$inferSelect;
type Program = {
  version: number;
  minimumCardVersion: number;
  program: StampProgramTerms;
  lastRequest: string | null;
};
type Connection = Database | Tx;

const initialProgram: StampProgramTerms = {
  enabled: false,
  name: "Loyalty card",
  appearance: "neutral",
  goal: 10,
  welcomeStamps: 0,
  qualifyingServiceIds: [],
  minimumSpendCents: 0,
  stampExpiryDays: null,
  expiryFrom: "issue",
  rewardExpiryDays: null,
  automaticIssue: true,
  awardOn: "checkout",
  terms: "",
  reward: { kind: "other", name: "Loyalty reward", targetId: null, discountBasisPoints: null },
};

async function currentProgram(db: Connection): Promise<Program> {
  const [row] = await db.select().from(stampProgram).where(eq(stampProgram.id, 1));
  return row
    ? {
        version: row.version,
        minimumCardVersion: row.minimumCardVersion,
        program: stampProgramTermsSchema.parse(row.terms),
        lastRequest: row.lastRequest,
      }
    : { version: 1, minimumCardVersion: 1, program: initialProgram, lastRequest: null };
}

async function lockProgramForCard(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended('stamp-program', 0))`);
  return currentProgram(tx);
}

export async function getStampProgram(db: Database, generation: string) {
  const { version, program } = await currentProgram(db);
  return { version, generation, program };
}

export async function updateStampProgram(
  db: Database,
  input: StampProgramInput,
  principal: Principal,
) {
  requireRole(principal, "owner");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('stamp-program', 0))`);
    const existing = await currentProgram(tx);
    const requestHash = rewardHash({ actor: principal.userId, input });
    if (existing.version === input.version + 1 && existing.lastRequest === requestHash) {
      return { version: existing.version, program: existing.program, generation: input.generation };
    }
    if (existing.version !== input.version)
      throw new DomainError("version_conflict", "Review the current card programme");

    const { program } = input;
    const ids = new Set(program.qualifyingServiceIds);
    if (program.reward.kind === "service" && program.reward.targetId)
      ids.add(program.reward.targetId);
    if (ids.size) {
      const matches = await tx
        .select({ id: service.id })
        .from(service)
        .where(and(inArray(service.id, [...ids]), isNull(service.deletedAt)));
      if (matches.length !== ids.size)
        throw new DomainError("invalid_state", "Review the inactive services in the programme");
    }
    if (program.reward.kind === "product" && program.reward.targetId) {
      const [target] = await tx
        .select({ id: retailProduct.id })
        .from(retailProduct)
        .where(and(eq(retailProduct.id, program.reward.targetId), eq(retailProduct.active, true)));
      if (!target) throw new DomainError("invalid_state", "Review the reward product");
    }
    const version = existing.version + 1;
    const values = {
      version,
      minimumCardVersion: input.existingCards === "void" ? version : existing.minimumCardVersion,
      terms: program,
      lastRequest: requestHash,
      updatedAt: new Date(),
    };
    await tx
      .insert(stampProgram)
      .values(values)
      .onConflictDoUpdate({ target: stampProgram.id, set: values });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "rewards.stamp_program_saved",
      entity: "stamp_program",
      entityId: "1",
      metadata: { version, existingCards: input.existingCards },
    });
    return { version, program, generation: input.generation };
  });
}

const expires = (now: Date, days: number | null) =>
  days === null ? null : new Date(now.getTime() + days * 86_400_000);
function state(card: Card, program: Program, now: Date): StampCard["state"] {
  if (card.redeemedAt) return "redeemed";
  if (card.voidedAt || card.programVersion < program.minimumCardVersion) return "void";
  if (card.completedAt) {
    if (card.rewardExpiresAt && card.rewardExpiresAt <= now) return "expired";
    return card.rewardIssuedAt ? "issued" : "completed";
  }
  return card.stampExpiresAt && card.stampExpiresAt <= now ? "expired" : "active";
}

function view(card: Card, program: Program, now: Date): StampCard {
  return {
    id: card.id,
    version: card.version,
    programVersion: card.programVersion,
    program: stampProgramTermsSchema.parse(card.program),
    stamps: card.stamps,
    state: state(card, program, now),
    needsReview: card.needsReview,
    createdAt: card.createdAt.toISOString(),
    stampExpiresAt: card.stampExpiresAt?.toISOString() ?? null,
    rewardExpiresAt: card.rewardExpiresAt?.toISOString() ?? null,
    completedAt: card.completedAt?.toISOString() ?? null,
    rewardIssuedAt: card.rewardIssuedAt?.toISOString() ?? null,
    redeemedAt: card.redeemedAt?.toISOString() ?? null,
  };
}

export async function listStampCards(db: Database, clientId: string, now: Date) {
  return db.transaction(
    async (tx) => {
      const root = await clientRoot(tx, clientId);
      const ids = await clientIdentityIds(tx, root.id);
      const program = await currentProgram(tx);
      const rows = await tx
        .select()
        .from(stampCard)
        .where(inArray(stampCard.clientId, ids))
        .orderBy(desc(stampCard.createdAt), desc(stampCard.id))
        .limit(100);
      return {
        cards: rows.map((row) => view(row, program, now)),
        programVersion: program.version,
        program: program.program,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const activeCard = async (tx: Tx, clientId: string, program: Program, now: Date) => {
  const identities = await clientIdentityIds(tx, clientId);
  const [card] = await tx
    .select()
    .from(stampCard)
    .where(
      and(
        inArray(stampCard.clientId, identities),
        gte(stampCard.programVersion, program.minimumCardVersion),
        isNull(stampCard.voidedAt),
        isNull(stampCard.completedAt),
        sql`(${stampCard.stampExpiresAt} is null or ${stampCard.stampExpiresAt} > ${now})`,
      ),
    )
    .orderBy(asc(stampCard.createdAt), asc(stampCard.id))
    .limit(1);
  return card;
};

async function enrol(
  tx: Tx,
  clientId: string,
  program: Program,
  now: Date,
  initial?: number,
  expiry?: string | null,
) {
  const terms = program.program;
  const stamps = initial ?? terms.welcomeStamps;
  if (stamps > terms.goal) throw new DomainError("invalid_state", "Stamps exceed the card goal");
  const complete = stamps === terms.goal;
  const [card] = await tx
    .insert(stampCard)
    .values({
      clientId,
      programVersion: program.version,
      program: terms,
      stamps,
      createdAt: now,
      updatedAt: now,
      stampExpiresAt:
        expiry === undefined
          ? expires(now, terms.stampExpiryDays)
          : expiry === null
            ? null
            : new Date(expiry),
      ...(complete
        ? { completedAt: now, rewardExpiresAt: expires(now, terms.rewardExpiryDays) }
        : {}),
    })
    .returning();
  if (!card) throw new Error("Stamp card insert failed");
  return card;
}

function requireStampOperator(principal: Principal) {
  requirePermission(principal, "commerce");
  requirePermission(principal, "editClients");
}

async function stampCommand(
  tx: Tx,
  principal: Principal,
  input: IssueStampCard | ChangeStampCard,
  subject: string,
) {
  const source = `operator:${principal.userId}:${input.idempotencyKey}`;
  const requestHash = rewardHash({ input, subject });
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${source}, 0))`);
  const [existing] = await tx
    .select()
    .from(stampCardEvent)
    .where(eq(stampCardEvent.source, source));
  if (existing && existing.requestHash !== requestHash)
    throw new DomainError(
      "version_conflict",
      "This request key was used for a different card action",
    );
  return { source, requestHash, existing };
}

async function cardById(tx: Tx, id: string) {
  const [card] = await tx.select().from(stampCard).where(eq(stampCard.id, id));
  if (!card) throw new DomainError("not_found", "Loyalty card not found");
  return card;
}

export async function issueStampCard(
  db: Database,
  input: IssueStampCard,
  principal: Principal,
  now: Date,
) {
  requireStampOperator(principal);
  return db.transaction(async (tx) => {
    const command = await stampCommand(tx, principal, input, input.clientId);
    const root = await lockClientRoot(tx, input.clientId);
    const program = await lockProgramForCard(tx);
    if (command.existing) return view(await cardById(tx, command.existing.cardId), program, now);
    if (root.id !== input.clientId)
      throw new DomainError("client_merged", "Review the surviving client before issuing a card");
    if (program.version !== input.programVersion)
      throw new DomainError(
        "version_conflict",
        "Review the current programme before issuing a card",
      );
    if (!program.program.enabled)
      throw new DomainError("invalid_state", "The stamp programme is disabled");
    if (await activeCard(tx, root.id, program, now))
      throw new DomainError("invalid_state", "This customer already has an active card");
    const card = await enrol(tx, root.id, program, now, input.initialStamps, input.expiresAt);
    await tx
      .insert(stampCardEvent)
      .values({ source: command.source, cardId: card.id, requestHash: command.requestHash });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "rewards.stamp_card_issued",
      entity: "stamp_card",
      entityId: card.id,
      metadata: { stamps: card.stamps, programVersion: program.version },
    });
    if (card.completedAt && program.program.automaticIssue) await enrol(tx, root.id, program, now);
    return view(card, program, now);
  });
}

export async function changeStampCard(
  db: Database,
  id: string,
  input: ChangeStampCard,
  principal: Principal,
  now: Date,
) {
  requireStampOperator(principal);
  return db.transaction(async (tx) => {
    const command = await stampCommand(tx, principal, input, id);
    const original = await cardById(tx, id);
    const root = await lockClientRoot(tx, original.clientId);
    const program = await lockProgramForCard(tx);
    const card = await cardById(tx, id);
    if (command.existing) return view(card, program, now);
    if (card.version !== input.version)
      throw new DomainError("version_conflict", "Review the current loyalty card");
    const current = state(card, program, now);
    const terms = stampProgramTermsSchema.parse(card.program);
    const changes: Partial<Card> = { updatedAt: now, version: card.version + 1 };
    if (input.type === "edit") {
      if (
        !["active", "completed", "expired"].includes(current) ||
        card.rewardIssuedAt ||
        input.stamps > terms.goal
      )
        throw new DomainError("invalid_state", "This card cannot be edited");
      changes.stamps = input.stamps;
      changes.stampExpiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
      changes.completedAt = input.stamps === terms.goal ? (card.completedAt ?? now) : null;
      changes.rewardExpiresAt = changes.completedAt
        ? expires(changes.completedAt, terms.rewardExpiryDays)
        : null;
    } else if (input.type === "void") {
      if (current === "void" || current === "redeemed")
        throw new DomainError("invalid_state", "This card cannot be voided");
      changes.voidedAt = now;
    } else if (input.type === "issue_reward" && current === "completed" && !card.needsReview) {
      changes.rewardIssuedAt = now;
    } else if (input.type === "redeem" && current === "issued" && !card.needsReview) {
      changes.redeemedAt = now;
    } else {
      throw new DomainError("invalid_state", "This reward cannot be issued or redeemed");
    }
    const [saved] = await tx.update(stampCard).set(changes).where(eq(stampCard.id, id)).returning();
    if (!saved) throw new Error("Stamp card update failed");
    await tx
      .insert(stampCardEvent)
      .values({ source: command.source, cardId: id, requestHash: command.requestHash });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: `rewards.stamp_card_${input.type}`,
      entity: "stamp_card",
      entityId: id,
      metadata: { stamps: saved.stamps, ...("reason" in input ? { reason: input.reason } : {}) },
    });
    if (
      !card.completedAt &&
      saved.completedAt &&
      program.program.enabled &&
      program.program.automaticIssue &&
      !(await activeCard(tx, root.id, program, now))
    )
      await enrol(tx, root.id, program, now);
    return view(saved, program, now);
  });
}

type Award = {
  source: string;
  kind: "checkout" | "appointment";
  checkoutId?: string;
  qualifiedSpend: (terms: StampProgramTerms) => number | Promise<number>;
  now: Date;
};

async function awardStamp(tx: Tx, clientId: string, award: Award) {
  const root = await lockClientRoot(tx, clientId, true);
  if (root.deletedAt) return;
  const current = await lockProgramForCard(tx);
  if (!current.program.enabled) return;
  const [duplicate] = await tx
    .select({ source: stampCardEvent.source })
    .from(stampCardEvent)
    .where(eq(stampCardEvent.source, award.source));
  if (duplicate) return;
  let card = await activeCard(tx, root.id, current, award.now);
  if (!card && !current.program.automaticIssue) return;
  const terms = card ? stampProgramTermsSchema.parse(card.program) : current.program;
  if (terms.awardOn !== award.kind) return;
  const spend = await award.qualifiedSpend(terms);
  if (spend <= 0 || spend < terms.minimumSpendCents) return;
  card ??= await enrol(tx, root.id, current, award.now);
  const then = card.stamps + 1;
  const complete = then === terms.goal;
  await tx
    .insert(stampCardEvent)
    .values({ source: award.source, cardId: card.id, checkoutId: award.checkoutId });
  await tx
    .update(stampCard)
    .set({
      stamps: then,
      version: card.version + 1,
      updatedAt: award.now,
      ...(terms.expiryFrom === "activity"
        ? { stampExpiresAt: expires(award.now, terms.stampExpiryDays) }
        : {}),
      ...(complete
        ? { completedAt: award.now, rewardExpiresAt: expires(award.now, terms.rewardExpiryDays) }
        : {}),
    })
    .where(eq(stampCard.id, card.id));
  if (
    complete &&
    current.program.automaticIssue &&
    !(await activeCard(tx, root.id, current, award.now))
  )
    await enrol(tx, root.id, current, award.now);
}

export type StampCheckoutValue = {
  eligibleOriginal: number;
  eligibleRetained: number;
  serviceRetained: Map<string, number>;
};
const checkoutSpend = (value: StampCheckoutValue, terms: StampProgramTerms) =>
  terms.qualifyingServiceIds.length
    ? terms.qualifyingServiceIds.reduce(
        (total, id) => total + (value.serviceRetained.get(id) ?? 0),
        0,
      )
    : value.eligibleRetained;

export async function syncCheckoutStamp(
  tx: Tx,
  sale: { id: string; clientId: string; appointmentId: string | null },
  value: StampCheckoutValue,
  initial: boolean,
  now: Date,
) {
  if (initial) {
    await awardStamp(tx, sale.clientId, {
      source: sale.appointmentId ? `visit:${sale.appointmentId}` : `checkout:${sale.id}`,
      checkoutId: sale.id,
      kind: "checkout",
      now,
      qualifiedSpend: (terms) => checkoutSpend(value, terms),
    });
    return;
  }
  if (value.eligibleRetained >= value.eligibleOriginal) return;
  const [event] = await tx
    .select()
    .from(stampCardEvent)
    .where(eq(stampCardEvent.checkoutId, sale.id));
  if (!event || event.revokedAt) return;
  const card = await cardById(tx, event.cardId);
  const terms = stampProgramTermsSchema.parse(card.program);
  const spend = checkoutSpend(value, terms);
  if (spend > 0 && spend >= terms.minimumSpendCents) return;
  const stamps = Math.max(0, card.stamps - 1);
  await tx
    .update(stampCardEvent)
    .set({ revokedAt: now })
    .where(eq(stampCardEvent.source, event.source));
  if (card.rewardIssuedAt) {
    await tx
      .update(stampCard)
      .set({ needsReview: true, version: card.version + 1, updatedAt: now })
      .where(eq(stampCard.id, card.id));
  } else {
    await tx
      .update(stampCard)
      .set({
        stamps,
        completedAt: null,
        rewardExpiresAt: null,
        version: card.version + 1,
        updatedAt: now,
      })
      .where(eq(stampCard.id, card.id));
  }
}

export async function awardAppointmentStamp(
  tx: Tx,
  visit: { id: string; clientId: string },
  now: Date,
) {
  const policy = await currentProgram(tx);
  if (!policy.program.enabled) return;
  await awardStamp(tx, visit.clientId, {
    source: `visit:${visit.id}`,
    kind: "appointment",
    now,
    qualifiedSpend: async (terms) => {
      const lines = await tx
        .select()
        .from(appointmentService)
        .where(eq(appointmentService.appointmentId, visit.id));
      return lines
        .filter(
          (line) =>
            line.currency === "EUR" &&
            (!terms.qualifyingServiceIds.length ||
              (line.serviceId && terms.qualifyingServiceIds.includes(line.serviceId))),
        )
        .reduce(
          (total, line) =>
            total + (line.reviewedPriceCents ?? (line.sourceUnpriced ? 0 : line.priceCents)),
          0,
        );
    },
  });
}
