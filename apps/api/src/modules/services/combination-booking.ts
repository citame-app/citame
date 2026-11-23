import { createHash } from "node:crypto";
import type { FixedCombinationReview } from "@sob/contracts";
import { type Database, serviceCombination } from "@sob/db";
import { eq } from "drizzle-orm";
import { DomainError } from "../../errors";
import { assertStaffExists } from "../staff/service";
import { getBookableServices } from "./service";

type ReadConnection = Pick<Database, "select">;

export async function resolveFixedCombination(
  db: ReadConnection,
  id: string,
  serviceIds: string[],
  serviceQuotes?: Record<string, string>,
  onlineOnly = false,
) {
  const [row] = await db.select().from(serviceCombination).where(eq(serviceCombination.id, id));
  if (
    !row?.active ||
    !row.fixedPricesCents ||
    !row.fixedStaffIds ||
    (onlineOnly && !row.fixedOnlineBooking)
  )
    throw new DomainError("not_found", "Fixed-price combination is unavailable");
  if (
    row.serviceIds.length !== serviceIds.length ||
    row.serviceIds.some((value, position) => value !== serviceIds[position]?.toLowerCase())
  )
    throw new DomainError("validation_error", "Select the combination's treatments in order");

  const prices = Array.from(row.fixedPricesCents);
  const staffIds = row.fixedStaffIds;
  if (prices.reduce((sum, cents) => sum + cents, 0) > 999_999_999)
    throw new DomainError("validation_error", "The combination total exceeds the supported amount");
  const current = await getBookableServices(db, row.serviceIds, serviceQuotes);
  const services = current.map((service, position) => {
    const priceCents = prices[position];
    if (priceCents === undefined) throw new Error("Missing fixed price for a combination line");
    return { ...service, priceCents, priceType: "fixed" as const };
  });
  const review = {
    id: row.id,
    version: row.version,
    reviewHash: createHash("sha256")
      .update(
        JSON.stringify([
          row.id,
          row.version,
          row.fixedOnlineBooking,
          staffIds,
          services.map(({ id, quoteHash, priceCents }) => [id, quoteHash, priceCents]),
        ]),
      )
      .digest("hex"),
  };
  return { services, staffIds, review, onlineBooking: row.fixedOnlineBooking };
}

export async function resolveBookingSelection(
  db: ReadConnection,
  request: {
    serviceIds: string[];
    serviceQuotes?: Record<string, string>;
    combination?: FixedCombinationReview;
  },
) {
  const selected = request.combination;
  if (!selected)
    return {
      services: await getBookableServices(db, request.serviceIds, request.serviceQuotes),
      fixed: undefined,
    };
  const fixed = await resolveFixedCombination(
    db,
    selected.id,
    request.serviceIds,
    request.serviceQuotes,
  );
  if (fixed.review.version !== selected.version || fixed.review.reviewHash !== selected.reviewHash)
    throw new DomainError(
      "version_conflict",
      "Combination terms changed; review the current total",
    );
  return { services: fixed.services, fixed };
}

export async function assertCombinationStaff(
  db: ReadConnection,
  staffId: string,
  staffIds: readonly string[],
) {
  if (!staffIds.includes(staffId.toLowerCase()))
    throw new DomainError(
      "validation_error",
      "The professional is not assigned to this combination",
    );
  await assertStaffExists(db, staffId);
}
