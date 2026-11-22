import { createHash } from "node:crypto";
import {
  type PeakPricePolicy,
  type PeakPriceQuote,
  type PeakPriceRule,
  peakPriceRulesSchema,
  peakPriceSnapshotSchema,
  type Service,
} from "@sob/contracts";
import { type Database, peakPricePolicy, service } from "@sob/db";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { loadPrincipal, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import { lockScheduling, type Tx } from "../../tx";
import { getBookableServices, onlineServicesByIds } from "../services/service";
import { getSalonSettings } from "../settings/service";

async function loadPeakPriceRules(
  db: Database | Tx,
): Promise<Pick<PeakPricePolicy, "version" | "rules">> {
  const [row] = await db.select().from(peakPricePolicy).where(eq(peakPricePolicy.id, 1));
  return { version: row?.version ?? 0, rules: peakPriceRulesSchema.parse(row?.rules ?? []) };
}

export async function readPeakPricePolicy(
  db: Database | Tx,
  generation: string,
): Promise<PeakPricePolicy> {
  return { ...(await loadPeakPriceRules(db)), generation };
}

export async function offlinePeakPriceSnapshot(db: Database | Tx) {
  const { timezone } = await getSalonSettings(db);
  return peakPriceSnapshotSchema.parse({ ...(await loadPeakPriceRules(db)), timezone });
}

function normalizeRules(rules: PeakPriceRule[]) {
  return rules
    .map((rule) => ({
      ...rule,
      serviceIds: [...new Set(rule.serviceIds.map((id) => id.toLowerCase()))].sort(),
    }))
    .sort(
      (left, right) =>
        left.weekday - right.weekday ||
        left.startMinute - right.startMinute ||
        left.endMinute - right.endMinute ||
        left.increaseBasisPoints - right.increaseBasisPoints ||
        left.serviceIds.join(",").localeCompare(right.serviceIds.join(",")),
    );
}

export async function savePeakPricePolicy(
  db: Database,
  proposed: PeakPricePolicy,
  principal: Principal,
  generation: string,
) {
  requirePermission(principal, "editCatalog");
  if (proposed.generation !== generation)
    throw new DomainError("sync_generation_changed", "Review peak prices on the restored server");
  const rules = normalizeRules(proposed.rules);
  return db.transaction(async (tx) => {
    await lockScheduling(tx);
    const actor = await loadPrincipal(tx, principal.userId);
    if (!actor) throw new DomainError("forbidden", "Account unavailable");
    requirePermission(actor, "editCatalog");
    const before = await readPeakPricePolicy(tx, generation);
    if (
      JSON.stringify(before.rules) === JSON.stringify(rules) &&
      (before.version === proposed.version || before.version === proposed.version + 1)
    )
      return before;
    if (before.version !== proposed.version || before.version >= 2_147_483_647)
      throw new DomainError("version_conflict", "Peak prices changed; review the latest policy");

    const selected = [...new Set(rules.flatMap((rule) => rule.serviceIds))];
    if (selected.length) {
      const active = await tx
        .select({ id: service.id })
        .from(service)
        .where(
          and(inArray(service.id, selected), isNull(service.deletedAt), eq(service.active, true)),
        );
      if (active.length !== selected.length)
        throw new DomainError("validation_error", "Choose active services for peak prices");
    }
    const version = before.version + 1;
    await tx
      .insert(peakPricePolicy)
      .values({ id: 1, version, rules })
      .onConflictDoUpdate({ target: peakPricePolicy.id, set: { version, rules } });
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "peak_price_policy.saved",
      entity: "peak_price_policy",
      entityId: "1",
      metadata: { version, rules },
    });
    return { version, generation, rules };
  });
}

function rulesAt(rules: PeakPriceRule[], startsAtMs: number, timeZone: string) {
  const local = Temporal.Instant.fromEpochMilliseconds(startsAtMs).toZonedDateTimeISO(timeZone);
  const minute = local.hour * 60 + local.minute;
  return rules.filter(
    (rule) =>
      rule.weekday === local.dayOfWeek && rule.startMinute <= minute && minute < rule.endMinute,
  );
}

/** Base catalogue prices, exact slot and reviewed policy jointly define the final amount. */
export function pricePeakSlot(
  policy: Pick<PeakPricePolicy, "version" | "rules">,
  services: Service[],
  startsAt: Date,
  timeZone: string,
): PeakPriceQuote {
  const instant = startsAt.toISOString();
  let offsetMinutes = 0;
  const lines = services.map((item) => {
    const serviceOffset = offsetMinutes;
    offsetMinutes += item.durationMinutes + item.bufferMinutes;
    const candidates = policy.rules.length
      ? rulesAt(policy.rules, startsAt.getTime() + serviceOffset * 60_000, timeZone)
      : [];
    const baseCents = item.priceCents;
    const eligible =
      item.priceType === undefined || item.priceType === "fixed" || item.priceType === "from";
    const increase = eligible
      ? candidates.reduce(
          (best, rule) =>
            !rule.serviceIds.length || rule.serviceIds.includes(item.id)
              ? Math.max(best, rule.increaseBasisPoints)
              : best,
          0,
        )
      : 0;
    const surchargeCents = Math.round((baseCents * increase) / 10_000);
    const priceCents = baseCents + surchargeCents;
    if (surchargeCents > 0 && priceCents > 999_999_999)
      throw new DomainError("validation_error", "Peak service price exceeds the supported amount");
    return {
      serviceId: item.id,
      currency: item.currency,
      baseCents,
      surchargeCents,
      priceCents,
    };
  });
  const review = lines.some((line) => line.surchargeCents)
    ? createHash("sha256")
        .update(
          JSON.stringify([
            policy.version,
            timeZone,
            instant,
            lines.map((line) => [
              line.serviceId,
              line.currency,
              line.baseCents,
              line.surchargeCents,
              line.priceCents,
            ]),
            services.map(({ quoteHash }) => quoteHash),
          ]),
        )
        .digest("hex")
    : null;
  return { startsAt: instant, review, services: lines };
}

export async function quotePeakSlot(
  db: Database | Tx,
  services: Service[],
  startsAt: Date,
  timeZone: string,
) {
  const policy = await loadPeakPriceRules(db);
  return pricePeakSlot(policy, services, startsAt, timeZone);
}

export async function previewPeakSlot(
  db: Database,
  serviceIds: string[],
  startsAt: string,
  publicOnly: boolean,
) {
  return db.transaction(
    async (tx) => {
      const services = await getBookableServices(tx, serviceIds);
      if (publicOnly && (await onlineServicesByIds(tx, serviceIds)).length !== services.length)
        throw new DomainError("not_found", "Service unavailable for online booking");
      const { timezone } = await getSalonSettings(tx);
      return quotePeakSlot(tx, services, new Date(startsAt), timezone);
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function assertPeakReviews(reviews: (string | undefined)[], accepted?: (string | null)[]) {
  if (!accepted && !reviews.some(Boolean)) return;
  if (
    accepted?.length !== reviews.length ||
    reviews.some((review, i) => (review ?? null) !== accepted[i])
  )
    throw new DomainError("peak_price_changed", "Review the current prices before booking");
}

export function assertPeakReview(quote: PeakPriceQuote, accepted?: string) {
  if (quote.review !== (accepted ?? null))
    throw new DomainError(
      "peak_price_changed",
      "Review the current price for this time before booking",
    );
}
