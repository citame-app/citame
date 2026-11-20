import { createHash, randomBytes } from "node:crypto";
import { type GiftCard, permissionsFor } from "@sob/contracts";
import { checkoutLine, type Database, giftCard, giftCardMovement } from "@sob/db";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { requirePermission } from "../../auth/policy";
import { ownedClientIds, type Principal } from "../../auth/principal";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";
import { giftCode, giftCodeHash } from "./code";

type Connection = Database | Tx;
export function authorizeGiftAccess(principal: Principal) {
  if (principal.role !== "client") requirePermission(principal, "commerce");
}
export function giftScope(principal: Principal) {
  authorizeGiftAccess(principal);
  return permissionsFor(principal.role, principal.accessPreset).allSales
    ? undefined
    : or(
        eq(giftCard.createdBy, principal.userId),
        principal.clientId ? inArray(giftCard.buyerClientId, ownedClientIds(principal)) : undefined,
      );
}
export async function visibleGift(db: Connection, id: string, principal: Principal, lock = false) {
  const query = db
    .select()
    .from(giftCard)
    .where(and(eq(giftCard.id, id), giftScope(principal)));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) throw new DomainError("not_found", "Gift card not found");
  return row;
}
export async function giftView(
  db: Connection,
  row: typeof giftCard.$inferSelect,
): Promise<GiftCard> {
  const [line] = await db
    .select({ checkoutId: checkoutLine.checkoutId })
    .from(checkoutLine)
    .where(eq(checkoutLine.giftCardId, row.id));
  if (!line) throw new Error("Gift card is missing its purchase receipt");
  return {
    id: row.id,
    label: row.label,
    buyerClientId: row.buyerClientId,
    checkoutId: line.checkoutId,
    amountCents: row.amountCents,
    balanceCents: row.balanceCents,
    reservedCents: row.reservedCents,
    availableCents: row.balanceCents - row.reservedCents,
    currency: "EUR",
    status:
      row.status === "active" && row.expiresAt && row.expiresAt.getTime() <= Date.now()
        ? "expired"
        : row.status,
    codeLast4: row.codeLast4,
    codeRevision: createHash("sha256").update(row.codeNonce).digest("hex"),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
  };
}
export async function getGift(db: Database, id: string, principal: Principal) {
  return db.transaction(async (tx) => giftView(tx, await visibleGift(tx, id, principal)), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}
export async function listGifts(
  db: Database,
  principal: Principal,
  page = 1,
  search = "",
  status?: GiftCard["status"],
) {
  const escaped = search.replace(/[\\%_]/g, "\\$&");
  const where = and(
    giftScope(principal),
    status
      ? sql`(case when ${giftCard.status}='active' and ${giftCard.expiresAt}<=now() then 'expired'::text else ${giftCard.status}::text end)=${status}`
      : undefined,
    search
      ? or(ilike(giftCard.label, `%${escaped}%`), eq(giftCard.codeLast4, search.toUpperCase()))
      : undefined,
  );
  return db.transaction(
    async (tx) => {
      const [total] = await tx.select({ n: count() }).from(giftCard).where(where);
      const rows = await tx
        .select()
        .from(giftCard)
        .where(where)
        .orderBy(desc(giftCard.createdAt), asc(giftCard.id))
        .limit(20)
        .offset((page - 1) * 20);
      const cards: GiftCard[] = [];
      for (const row of rows) cards.push(await giftView(tx, row));
      return { cards, pagination: { page, pageSize: 20, total: total?.n ?? 0 } };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function revealGift(db: Database, id: string, principal: Principal, secret: string) {
  return db.transaction(
    async (tx) => {
      const row = await visibleGift(tx, id, principal);
      if (row.status !== "active")
        throw new DomainError("invalid_state", "Only paid gift cards have a redeemable code");
      const code = giftCode(secret, row.id, row.codeNonce);
      if (giftCodeHash(code) !== row.codeHash)
        throw new DomainError(
          "invalid_state",
          "Gift code must be reissued after a server key change",
        );
      return { code, card: await giftView(tx, row) };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
export async function checkGift(db: Database, code: string, principal: Principal) {
  authorizeGiftAccess(principal);
  const [row] = await db
    .select()
    .from(giftCard)
    .where(eq(giftCard.codeHash, giftCodeHash(code)));
  if (!row) throw new DomainError("not_found", "Gift card not found");
  return {
    balanceCents: row.balanceCents,
    reservedCents: row.reservedCents,
    availableCents: row.balanceCents - row.reservedCents,
    currency: "EUR" as const,
    status:
      row.status === "active" && row.expiresAt && row.expiresAt.getTime() <= Date.now()
        ? ("expired" as const)
        : row.status,
    codeLast4: row.codeLast4,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}
export async function changeGiftExpiry(
  db: Database,
  id: string,
  input: { expiresAt: string | null; reason: string; version: number },
  principal: Principal,
) {
  requirePermission(principal, "refunds");
  return db.transaction(async (tx) => {
    const row = await visibleGift(tx, id, principal, true);
    if (row.version !== input.version)
      throw new DomainError("version_conflict", "Gift card changed; reload before editing");
    const [updated] = await tx
      .update(giftCard)
      .set({
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        version: row.version + 1,
      })
      .where(eq(giftCard.id, id))
      .returning();
    if (!updated) throw new Error("Gift expiry update failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "gift_card.expiry_changed",
      entity: "gift_card",
      entityId: id,
      metadata: { expiresAt: input.expiresAt, reason: input.reason },
    });
    return giftView(tx, updated);
  });
}
export async function reissueGift(
  db: Database,
  id: string,
  input: { reason: string; version: number },
  principal: Principal,
  secret: string,
) {
  requirePermission(principal, "refunds");
  return db.transaction(async (tx) => {
    const row = await visibleGift(tx, id, principal, true);
    if (row.status !== "active" || row.version !== input.version)
      throw new DomainError(
        "version_conflict",
        "Gift card changed or is not active; reload before reissuing",
      );
    const nonce = randomBytes(16).toString("hex");
    const code = giftCode(secret, id, nonce);
    const [updated] = await tx
      .update(giftCard)
      .set({
        codeNonce: nonce,
        codeHash: giftCodeHash(code),
        codeLast4: code.slice(-4),
        version: row.version + 1,
      })
      .where(eq(giftCard.id, id))
      .returning();
    if (!updated) throw new Error("Gift code reissue failed");
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "gift_card.code_reissued",
      entity: "gift_card",
      entityId: id,
      metadata: { reason: input.reason },
    });
    return giftView(tx, updated);
  });
}
export async function giftHistory(db: Database, id: string, principal: Principal, page = 1) {
  return db.transaction(
    async (tx) => {
      await visibleGift(tx, id, principal);
      const [total] = await tx
        .select({ n: count() })
        .from(giftCardMovement)
        .where(eq(giftCardMovement.giftCardId, id));
      const rows = await tx
        .select()
        .from(giftCardMovement)
        .where(eq(giftCardMovement.giftCardId, id))
        .orderBy(desc(giftCardMovement.createdAt), desc(giftCardMovement.id))
        .limit(20)
        .offset((page - 1) * 20);
      return {
        movements: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          amountCents: row.amountCents,
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: { page, pageSize: 20, total: total?.n ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
