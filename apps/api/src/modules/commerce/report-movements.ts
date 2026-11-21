import { type SQL, sql } from "drizzle-orm";
import { completedRefundStatus, recordedPaymentStatuses } from "./money";

const paymentStatuses = sql.join(
  recordedPaymentStatuses.map((status) => sql`${status}`),
  sql`, `,
);

/** Each report joins the receipt as c. Filter by its attributed professional and client identity. */
export function checkoutReportScope(staffId?: string, clientId?: string) {
  const staff = staffId ? sql`and c.staff_id = ${staffId}` : sql``;
  const client = clientId
    ? sql`and c.client_id in (select client_identity_ids(${clientId}::uuid))`
    : sql``;
  return sql`${staff} ${client}`;
}

/** The recorded payment and refund events in a half-open reporting period. */
export function recordedCheckoutMovements(fromAt: Date | string, toAt: Date | string, scope: SQL) {
  return sql`
    select c.client_id, p.method, p.amount_cents::bigint as amount, false as refund
    from checkout_payment p join checkout c on c.id = p.checkout_id
    where p.status in (${paymentStatuses})
      and p.updated_at >= ${fromAt}::timestamptz and p.updated_at < ${toAt}::timestamptz ${scope}
    union all
    select c.client_id, p.method, r.amount_cents::bigint, true
    from checkout_refund r join checkout_payment p on p.id = r.payment_id
    join checkout c on c.id = p.checkout_id
    where r.status = ${completedRefundStatus}
      and r.updated_at >= ${fromAt}::timestamptz and r.updated_at < ${toAt}::timestamptz ${scope}
  `;
}
