import type { ReportBusinessOverview } from "@sob/contracts";
import { retailProduct } from "@sob/db";
import { type SQL, sql } from "drizzle-orm";
import type { Tx } from "../../tx";
import {
  checkoutReportScope,
  externallyCollectedMovement,
  netMovement,
  recordedCheckoutMovements,
} from "../commerce/report-movements";
import { lowStockPredicate } from "../inventory/service";

import { completedClientVisitScope, visitedClientIdentity } from "./client-visits";

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
      select count(distinct ${visitedClientIdentity})::int
      from appointment a
      where ${completedClientVisitScope({ fromAt, toAt, onlyStaff })}
    ) as "visitingClients", (
      select coalesce(${netMovement}, 0)::text
      from (${recordedCheckoutMovements(fromAt, toAt, checkoutReportScope(staffId))}) movements
      where ${externallyCollectedMovement}
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
