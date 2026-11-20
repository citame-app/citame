import { z } from "zod";
import { type BooksySourceReadModel, booksyCents } from "./source-read-model";

const archivedGroup = z.object({
  appointment: z.object({ payment_info: z.unknown().optional() }),
});
const payment = z.object({
  deposit_id: z.number().int().positive().nullable(),
  deposit_info: z.unknown(),
  transaction_id: z.unknown(),
  transaction_info: z.unknown(),
});
const money = z.union([z.string(), z.number()]);
const deposit = z.object({
  id: z.number().int().positive(),
  already_paid: money,
  total: money,
  remaining: money,
  status_type: z.string(),
  short_status: z.string(),
  pnref: z.unknown(),
  payment_rows: z.array(z.object({ status: z.string(), payment_intent: z.unknown() })).min(1),
});

function classifyPaymentDetail(detail: unknown) {
  if (detail == null) return "withoutPaymentDetail";
  const info = payment.safeParse(detail);
  if (!info.success) return "needsReconciliation";

  const transactionPresent =
    info.data.transaction_id !== null || info.data.transaction_info !== null;
  if (info.data.deposit_info === null && info.data.deposit_id === null)
    return transactionPresent ? "needsReconciliation" : "withoutDeposit";

  const captured = deposit.safeParse(info.data.deposit_info);
  if (!captured.success || captured.data.id !== info.data.deposit_id) return "needsReconciliation";

  const row = captured.data;
  try {
    const paid = booksyCents(row.already_paid);
    const total = booksyCents(row.total);
    const remaining = booksyCents(row.remaining);
    if (paid > 0) return "observedPositivePayment";
    if (
      paid === 0 &&
      !transactionPresent &&
      total === remaining &&
      row.status_type === "authorized" &&
      row.short_status === "authorized" &&
      row.pnref === null &&
      row.payment_rows.every(
        (entry) => entry.status === "authorized" && entry.payment_intent === null,
      )
    ) {
      return "authorizedWithoutCharge";
    }
    return "needsReconciliation";
  } catch {
    return "needsReconciliation";
  }
}

export function readBooksyPaymentEvidence(rawGroup: unknown): {
  detail: unknown;
  state: ReturnType<typeof classifyPaymentDetail>;
} {
  const group = archivedGroup.safeParse(rawGroup);
  const detail = group.data?.appointment.payment_info ?? null;
  return { detail, state: classifyPaymentDetail(detail) };
}

/** Compare captured evidence without converting authorizations or payment references into sales. */
export function reviewBooksyPaymentEvidence(model: Pick<BooksySourceReadModel, "groups">) {
  const counts = {
    withoutPaymentDetail: 0,
    withoutDeposit: 0,
    authorizedWithoutCharge: 0,
    observedPositivePayment: 0,
    needsReconciliation: 0,
  };
  for (const group of model.groups) counts[readBooksyPaymentEvidence(group.raw).state]++;
  return counts;
}
