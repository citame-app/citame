import type { ReportClients, ReportQuery } from "@sob/contracts";
import type { Database } from "@sob/db";
import { sql } from "drizzle-orm";
import { groupName } from "../clients/groups";
import { reportDateScope } from "./service";

/** Count each identity once, grouped by its first completed visit within the selected scope. */
export function reportClients(db: Database, query: ReportQuery): Promise<ReportClients> {
  return db.transaction(
    async (tx) => {
      const { timezone, fromAt, toAt, onlyStaff } = await reportDateScope(tx, query);
      type ClientBreakdown = {
        rows: ReportClients["rows"];
        groups: NonNullable<ReportClients["groups"]>;
        frequency: NonNullable<ReportClients["frequency"]>;
      };
      const result = await tx.execute<ClientBreakdown>(sql`
        with first_in_scope as (
          select client_root_id(a.client_id) as profile_id, min(a.starts_at) as starts_at,
            count(distinct (a.visit_group_id, case when a.visit_group_id is null then a.id end))
              as visits
          from appointment a
          where a.deleted_at is null and a.status = 'completed'
            and a.starts_at >= ${fromAt}::timestamptz and a.starts_at < ${toAt}::timestamptz
            ${onlyStaff}
          group by 1
        ), classified as (
          select (scoped.starts_at at time zone ${timezone})::date as day,
            exists (
              select 1 from client_identity_ids(scoped.profile_id) as identity(id)
              join appointment prior on prior.client_id = identity.id
              where prior.deleted_at is null and prior.status = 'completed'
                and prior.starts_at < ${fromAt}::timestamptz
            ) as has_history
          from first_in_scope scoped
        ), daily as (
          select day::text as date,
            count(*) filter (where not has_history)::int as "newClients",
            count(*) filter (where has_history)::int as "returningClients"
          from classified
          group by day
        ), by_group as (
          select ${groupName} as name, count(distinct profile.id)::int as clients
          from first_in_scope scoped
          join client_profile profile on profile.id = scoped.profile_id
          cross join lateral unnest(profile.tags) as client_tag(name)
          where profile.deleted_at is null and ${groupName} <> ''
          group by 1
        )
        select
          coalesce((select jsonb_agg(daily order by date) from daily), '[]'::jsonb) as rows,
          coalesce((select jsonb_agg(by_group order by clients desc, name) from by_group),
            '[]'::jsonb) as groups,
          (select jsonb_build_object(
            'one', count(*) filter (where visits = 1),
            'two', count(*) filter (where visits = 2),
            'threeOrMore', count(*) filter (where visits >= 3)
          ) from first_in_scope) as frequency
      `);
      const { rows, groups, frequency } = result[0] as ClientBreakdown;
      const totals = rows.reduce(
        (sum, row) => ({
          newClients: sum.newClients + row.newClients,
          returningClients: sum.returningClients + row.returningClients,
        }),
        { newClients: 0, returningClients: 0 },
      );
      return { from: query.from, to: query.to, totals, rows, groups, frequency };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
