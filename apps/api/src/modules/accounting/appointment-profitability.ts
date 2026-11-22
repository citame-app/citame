import type {
  AppointmentDirectCostInput,
  AppointmentProfitability,
  AppointmentProfitabilityQuery,
  AppointmentProfitabilityRow,
} from "@sob/contracts";
import { appointment, appointmentDirectCost, type Database } from "@sob/db";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { recordAudit } from "../../audit";
import { authorizeClientAccess, requirePermission } from "../../auth/policy";
import type { Principal } from "../../auth/principal";
import { clientRoot } from "../../client-identity";
import { DomainError } from "../../errors";
import { streamCsv } from "../../csv";
import type { Tx } from "../../tx";
import { checkoutReportScope } from "../commerce/report-movements";
import { getSalonSettings } from "../settings/service";
import { redeemedAtSettlement } from "./settled-families";

const PAGE_SIZE = 25;
type Cost = typeof appointmentDirectCost.$inferSelect;
const costView = ({ labourCents, materialsCents, version }: Cost) => ({
  labourCents,
  materialsCents,
  version,
});

function requireProfitabilityAccess(principal: Principal) {
  requirePermission(principal, "financialReports");
  requirePermission(principal, "readCosts");
}

export async function saveAppointmentDirectCost(
  db: Database,
  appointmentId: string,
  input: AppointmentDirectCostInput,
  principal: Principal,
) {
  requireProfitabilityAccess(principal);
  const values = { labourCents: input.labourCents, materialsCents: input.materialsCents };
  return db.transaction(async (tx) => {
    const [booked] = await tx
      .select({ id: appointment.id })
      .from(appointment)
      .where(eq(appointment.id, appointmentId))
      .for("share");
    if (!booked) throw new DomainError("not_found", "Appointment not found");
    const findCost = () =>
      tx
        .select()
        .from(appointmentDirectCost)
        .where(eq(appointmentDirectCost.appointmentId, appointmentId))
        .for("update");
    const [existing] = await findCost();
    const sameAmounts = (row: Cost) =>
      row.labourCents === values.labourCents && row.materialsCents === values.materialsCents;
    const isRetry = (row: Cost) => row.version === (input.version ?? 0) + 1 && sameAmounts(row);
    if (
      existing &&
      (isRetry(existing) || (existing.version === input.version && sameAmounts(existing)))
    )
      return costView(existing);
    if ((existing?.version ?? null) !== input.version)
      throw new DomainError(
        "version_conflict",
        "Appointment costs changed; review the latest amounts",
      );
    const [saved] = existing
      ? await tx
          .update(appointmentDirectCost)
          .set({ ...values, version: existing.version + 1, updatedAt: new Date() })
          .where(
            and(
              eq(appointmentDirectCost.appointmentId, appointmentId),
              eq(appointmentDirectCost.version, existing.version),
            ),
          )
          .returning()
      : await tx
          .insert(appointmentDirectCost)
          .values({ appointmentId, ...values })
          .onConflictDoNothing()
          .returning();
    if (!saved) {
      const [concurrent] = await findCost();
      if (concurrent && isRetry(concurrent)) return costView(concurrent);
      throw new DomainError(
        "version_conflict",
        "Appointment costs changed; review the latest amounts",
      );
    }
    await recordAudit(tx, {
      actorUserId: principal.userId,
      action: "accounting.appointment_costs_reviewed",
      entity: "appointment",
      entityId: appointmentId,
      metadata: { previous: existing ? costView(existing) : null, costs: costView(saved) },
    });
    return costView(saved);
  });
}

type LedgerRow = {
  checkoutId: string;
  appointmentId: string;
  staffId: string | null;
  staffName: string | null;
  startsAt: Date | string;
  settledAt: Date | string;
  netSales: string | number | null;
  productCost: string | number;
  unknownProductLines: number;
  commission: string | number;
  labourCents: number | null;
  materialsCents: number | null;
  costVersion: number | null;
  refundReview: boolean;
};

export async function reportAppointmentProfitability(
  db: Database,
  query: AppointmentProfitabilityQuery,
  principal: Principal,
): Promise<Omit<AppointmentProfitability, "generation">> {
  requireProfitabilityAccess(principal);
  if (query.clientId) authorizeClientAccess(principal);
  return db.transaction(
    async (tx) => {
      const { timezone, eligible } = await profitabilityScope(tx, query);
      const [count] = await tx.execute<{ total: number }>(
        sql`select count(*)::int as total from checkout c where ${eligible}`,
      );
      return {
        from: query.from,
        to: query.to,
        timezone,
        rows: await readProfitabilityRows(
          tx,
          eligible,
          PAGE_SIZE,
          sql`offset ${(query.page - 1) * PAGE_SIZE}`,
        ),
        pagination: { page: query.page, pageSize: PAGE_SIZE, total: count?.total ?? 0 },
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

async function profitabilityScope(db: Database | Tx, query: AppointmentProfitabilityQuery) {
  const { timezone } = await getSalonSettings(db);
  const from = Temporal.PlainDate.from(query.from).toZonedDateTime(timezone).toInstant().toString();
  const to = Temporal.PlainDate.from(query.to)
    .add({ days: 1 })
    .toZonedDateTime(timezone)
    .toInstant()
    .toString();
  const client = query.clientId ? await clientRoot(db, query.clientId) : null;
  const eligible = sql`c.appointment_id is not null and c.status <> 'void'
      and c.fulfilled_at >= ${from}::timestamptz and c.fulfilled_at < ${to}::timestamptz
      ${checkoutReportScope(query.staffId, client?.id)}`;
  return { timezone, eligible };
}

async function readProfitabilityRows(
  tx: Tx,
  eligible: SQL,
  limit: number,
  offset: SQL = sql``,
): Promise<AppointmentProfitabilityRow[]> {
  const entries = await tx.execute<LedgerRow>(sql`
      with selected as (
        select c.* from checkout c where ${eligible}
        order by c.fulfilled_at desc, c.id desc
        limit ${limit} ${offset}
      )
      select c.id as "checkoutId", a.id as "appointmentId", c.staff_id as "staffId", staff.display_name as "staffName",
        a.starts_at as "startsAt", c.fulfilled_at as "settledAt",
        case when lines.matches_subtotal and lines.matches_discount and lines.matches_tax and lines.is_allocated
          then lines.net_sales end as "netSales",
        lines.product_cost as "productCost", lines.unknown_products as "unknownProductLines",
        coalesce((select sum(ca.earned_cents) from commission_accrual ca where ca.checkout_id = c.id), 0) as commission,
        cost.labour_cents as "labourCents", cost.materials_cents as "materialsCents",
        cost.version as "costVersion",
        exists(select 1 from checkout_payment p join checkout_refund r on r.payment_id = p.id
          where p.checkout_id = c.id and r.status <> 'failed') as "refundReview"
      from selected c
      join appointment a on a.id = c.appointment_id
      left join staff_profile staff on staff.id = c.staff_id
      left join appointment_direct_cost cost on cost.appointment_id = a.id
      cross join lateral (
        select sum(gross) = c.subtotal_cents as matches_subtotal,
          sum(l.discount_cents) = c.discount_cents as matches_discount,
          sum(l.tax_cents) = c.tax_cents as matches_tax,
          bool_and(l.kind in ('service', 'product') and not l.price_pending
            and l.discount_cents between 0 and gross
            and l.tax_cents between 0 and gross - l.discount_cents) as is_allocated,
          sum(coalesce(prepaid.net, gross - l.discount_cents - l.tax_cents)) as net_sales,
          coalesce(sum(l.quantity * l.unit_cost_cents::bigint)
            filter (where l.kind = 'product' and l.unit_cost_cents >= 0), 0) as product_cost,
          count(*) filter (where l.kind = 'product'
            and (l.unit_cost_cents is null or l.unit_cost_cents < 0))::int as unknown_products
        from checkout_line l
        cross join lateral (select l.quantity * l.unit_amount_cents::bigint as gross) value
        left join lateral (
          select sum(pr.allocated_cents::bigint - pr.tax_cents) as net from pass_redemption pr
          where l.kind = 'service' and pr.checkout_line_id = l.id and pr.checkout_id = c.id
            and ${redeemedAtSettlement}
        ) prepaid on true
        where l.checkout_id = c.id
      ) lines
      order by c.fulfilled_at desc, c.id desc
    `);
  return entries.map((entry): AppointmentProfitabilityRow => {
    const netSalesCents = entry.netSales === null ? null : Number(entry.netSales);
    const productCostCents = Number(entry.productCost);
    const commissionCents = Number(entry.commission);
    const { labourCents, materialsCents } = entry;
    const marginCents =
      !entry.refundReview &&
      netSalesCents !== null &&
      labourCents !== null &&
      materialsCents !== null &&
      entry.unknownProductLines === 0
        ? netSalesCents - productCostCents - commissionCents - labourCents - materialsCents
        : null;
    return {
      checkoutId: entry.checkoutId,
      appointmentId: entry.appointmentId,
      staffId: entry.staffId,
      staffName: entry.staffName,
      startsAt: new Date(entry.startsAt).toISOString(),
      settledAt: new Date(entry.settledAt).toISOString(),
      netSalesCents,
      productCostCents,
      unknownProductLines: entry.unknownProductLines,
      commissionCents,
      directCosts:
        entry.costVersion === null
          ? null
          : { labourCents, materialsCents, version: entry.costVersion },
      marginCents,
      reviewReason: entry.refundReview
        ? "refund_review"
        : netSalesCents === null
          ? "unallocated_receipt"
          : marginCents === null
            ? "missing_costs"
            : null,
    };
  });
}

export async function exportAppointmentProfitability(
  db: Database,
  query: AppointmentProfitabilityQuery,
  principal: Principal,
  headOnly: boolean,
) {
  requireProfitabilityAccess(principal);
  if (query.clientId) {
    authorizeClientAccess(principal);
    await clientRoot(db, query.clientId);
  }
  let eligible: SQL | undefined;
  return streamCsv<AppointmentProfitabilityRow>(db, {
    filename: `appointment-profitability-${query.from}-${query.to}.csv`,
    headOnly,
    columns: [
      "appointment_id",
      "checkout_id",
      "starts_at",
      "settled_at",
      "staff_id",
      "staff_name",
      "net_sales_cents",
      "product_cost_cents",
      "unknown_product_lines",
      "commission_cents",
      "labour_cents",
      "materials_cents",
      "direct_margin_cents",
      "review_reason",
      "currency",
    ],
    readBatch: async (tx, cursor, limit) => {
      eligible ??= (await profitabilityScope(tx, query)).eligible;
      const position = cursor
        ? sql`and (c.fulfilled_at, c.id) < (select prior.fulfilled_at, prior.id
            from checkout prior where prior.id = ${cursor.checkoutId})`
        : sql``;
      return readProfitabilityRows(tx, sql`${eligible} ${position}`, limit);
    },
    cells: (row) => [
      row.appointmentId,
      row.checkoutId,
      row.startsAt,
      row.settledAt,
      row.staffId,
      row.staffName,
      row.netSalesCents,
      row.productCostCents,
      row.unknownProductLines,
      row.commissionCents,
      row.directCosts?.labourCents ?? null,
      row.directCosts?.materialsCents ?? null,
      row.marginCents,
      row.reviewReason,
      "EUR",
    ],
  });
}
