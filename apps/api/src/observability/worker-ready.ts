import {
  accountEmailOutbox,
  type Database,
  marketingCampaign,
  marketingDelivery,
  reminder,
} from "@sob/db";
import { getTableName, sql } from "drizzle-orm";
import { probeReadiness } from "./ready";

const queueTables = [reminder, accountEmailOutbox, marketingCampaign, marketingDelivery];
const queueRelations = sql.join(
  queueTables.map((table) => sql`to_regclass(${`public.${getTableName(table)}`})`),
  sql`, `,
);

export function startWorkerReadiness(db: Pick<Database, "execute">, port: number) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 5,
    async fetch(request) {
      if (request.method !== "GET" || new URL(request.url).pathname !== "/ready") {
        return new Response(null, { status: 404 });
      }
      const queues = await probeReadiness(async () => {
        const [access] = await db.execute<{ allowed: boolean }>(sql`
          select has_schema_privilege('public', 'USAGE') and bool_and(
            relation is not null
            and has_table_privilege(relation, 'SELECT')
            and has_table_privilege(relation, 'UPDATE')
          ) as allowed
          from unnest(array[${queueRelations}]) as queue(relation)
        `);
        if (!access?.allowed) throw new Error("Unavailable notification queue tables");
      });
      return new Response(null, { status: queues === "ok" ? 204 : 503 });
    },
  });
}
