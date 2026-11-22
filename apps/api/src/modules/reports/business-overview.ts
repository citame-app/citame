import type { ReportBusinessOverview } from "@sob/contracts";
import { retailProduct } from "@sob/db";
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import { storedValuePaymentMethods } from "../commerce/money";
import { checkoutReportScope, recordedCheckoutMovements } from "../commerce/report-movements";
import { lowStockPredicate } from "../inventory/service";

const internalMethods = sql.join(
  storedValuePaymentMethods.map((method) => sql`${method}`),
  sql`, `,
);

/** Client and cash activity follow the report's dates and professional. Stock is a current centre-wide count. */
export async function reportBusinessOverview(
  tx: Tx,
  {
    fromAt,
    toAt,
    onlyStaff,
    staffId,
  }: { fromAt: string; toAt: string; onlyStaff: SQL; staffId?: string },
): Promise<Omit<ReportBusinessOverview, "occupancyRate">> {
  const [row] = await tx.execute<{
    visitingClients: number;
    netCollected: string;
    lowStockProducts: number;
  }>(sql`
    select (
      select count(distinct client_root_id(a.client_id))::int
      from appointment a
      where a.deleted_at is null and a.status = 'completed'
        and a.starts_at >= ${fromAt}::timestamptz and a.starts_at < ${toAt}::timestamptz
        ${onlyStaff}
    ) as "visitingClients", (
      select coalesce(sum(case when refund then -amount else amount end), 0)::text
      from (${recordedCheckoutMovements(fromAt, toAt, checkoutReportScope(staffId))}) movements
      where method not in (${internalMethods})
    ) as "netCollected", (
      select count(*)::int from ${retailProduct}
      where ${retailProduct.active} and ${lowStockPredicate}
    ) as "lowStockProducts"
  `);
  if (!row) throw new Error("Business overview query returned no row");
  return {
    visitingClients: row.visitingClients,
    netCollectedCents: Number(row.netCollected),
    lowStockProducts: row.lowStockProducts,
  };
}
