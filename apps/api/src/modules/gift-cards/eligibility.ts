import { checkoutLine, checkoutPayment, giftCard, passRedemption } from "@sob/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DomainError } from "../../errors";
import type { Tx } from "../../tx";

type RestrictedTender = {
  amountCents: number;
  services: ReadonlyArray<{ id: string }>;
};

type Vertex = Edge[];
type Edge = {
  from: Vertex;
  to: Vertex;
  remaining: number;
  reverse?: Edge;
};

function connect(from: Vertex, to: Vertex, remaining: number) {
  const forward: Edge = { from, to, remaining };
  const reverse: Edge = { from: to, to: from, remaining: 0, reverse: forward };
  forward.reverse = reverse;
  from.push(forward);
  to.push(reverse);
}

/** Match restricted tenders to service capacity while allowing earlier matches to move. */
function canCover(tenders: RestrictedTender[], capacity: Map<string, number>): boolean {
  const source: Vertex = [];
  const sink: Vertex = [];
  const serviceNodes = new Map<string, Vertex>();
  for (const [serviceId, value] of capacity) {
    const node: Vertex = [];
    serviceNodes.set(serviceId, node);
    connect(node, sink, value);
  }
  let unallocated = 0;
  for (const tender of tenders) {
    const node: Vertex = [];
    connect(source, node, tender.amountCents);
    unallocated += tender.amountCents;
    for (const service of tender.services) {
      const serviceNode = serviceNodes.get(service.id);
      if (serviceNode) connect(node, serviceNode, tender.amountCents);
    }
  }

  // A reverse edge lets an earlier tender move to another eligible service when
  // a narrower tender needs its old slot.
  while (unallocated > 0) {
    const queue = [source];
    const parents = new Map<Vertex, Edge>();
    for (const node of queue) {
      if (parents.has(sink)) break;
      for (const edge of node) {
        if (edge.remaining <= 0 || edge.to === source || parents.has(edge.to)) continue;
        parents.set(edge.to, edge);
        queue.push(edge.to);
      }
    }
    if (!parents.has(sink)) return false;
    const path: Edge[] = [];
    let amount = unallocated;
    for (let edge = parents.get(sink); edge; edge = parents.get(edge.from)) {
      amount = Math.min(amount, edge.remaining);
      path.push(edge);
    }
    for (const edge of path) {
      if (!edge.reverse) throw new Error("Missing reverse settlement edge");
      edge.remaining -= amount;
      edge.reverse.remaining += amount;
    }
    unallocated -= amount;
  }
  return true;
}

/** Call under the checkout lock, with any new pass redemption already in the transaction. */
export async function assertGiftServiceCoverage(
  tx: Tx,
  checkoutId: string,
  next?: RestrictedTender,
) {
  const tenders = await tx
    .select({ amountCents: checkoutPayment.amountCents, services: giftCard.eligibleServices })
    .from(checkoutPayment)
    .innerJoin(giftCard, eq(checkoutPayment.giftCardId, giftCard.id))
    .where(
      and(
        eq(checkoutPayment.checkoutId, checkoutId),
        eq(checkoutPayment.method, "gift_card"),
        eq(checkoutPayment.status, "succeeded"),
        sql`jsonb_array_length(${giftCard.eligibleServices}) > 0`,
      ),
    );
  const allTenders = next ? [...tenders, next] : tenders;
  if (allTenders.length === 0) return;

  const lines = await tx
    .select({
      serviceId: checkoutLine.serviceId,
      unitAmountCents: checkoutLine.unitAmountCents,
      quantity: checkoutLine.quantity,
      discountCents: checkoutLine.discountCents,
    })
    .from(checkoutLine)
    .leftJoin(
      passRedemption,
      and(eq(passRedemption.checkoutLineId, checkoutLine.id), isNull(passRedemption.refundedAt)),
    )
    .where(
      and(
        eq(checkoutLine.checkoutId, checkoutId),
        eq(checkoutLine.kind, "service"),
        eq(checkoutLine.pricePending, false),
        isNull(passRedemption.id),
      ),
    );
  const capacity = new Map<string, number>();
  for (const line of lines) {
    const amount = line.quantity * line.unitAmountCents - line.discountCents;
    if (line.serviceId && amount > 0)
      capacity.set(line.serviceId, (capacity.get(line.serviceId) ?? 0) + amount);
  }
  if (!canCover(allTenders, capacity))
    throw new DomainError(
      "invalid_state",
      "Restricted gift card payments exceed the eligible service amount",
    );
}
