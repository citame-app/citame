import { sql } from "drizzle-orm";
import { completedRefundStatus, recordedPaymentStatuses } from "./money";

const paymentStatuses = sql.join(
  recordedPaymentStatuses.map((status) => sql`${status}`),
  sql`, `,
);

/** The recorded payment and refund events in a half-open reporting period. */
export function recordedCheckoutMovements(
  fromAt: Date | string,
  toAt: Date | string,
  staffId?: string,
) {
  const staff = staffId ? sql`and c.staff_id = ${staffId}` : sql``;
  return sql`
    select c.client_id, p.method, p.amount_cents::bigint as amount, false as refund
    from checkout_payment p join checkout c on c.id = p.checkout_id
    where p.status in (${paymentStatuses})
      and p.updated_at >= ${fromAt}::timestamptz and p.updated_at < ${toAt}::timestamptz ${staff}
    union all
    select c.client_id, p.method, r.amount_cents::bigint, true
    from checkout_refund r join checkout_payment p on p.id = r.payment_id
    join checkout c on c.id = p.checkout_id
    where r.status = ${completedRefundStatus}
      and r.updated_at >= ${fromAt}::timestamptz and r.updated_at < ${toAt}::timestamptz ${staff}
  `;
}
