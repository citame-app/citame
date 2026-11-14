// SQL proof for the contention run: no two live appointments of one staff member overlap.
// `bun k6/check-overlaps.ts` (DATABASE_URL, default: the local compose Postgres).
import { SQL } from "bun";

const sql = new SQL(process.env.DATABASE_URL ?? "postgres://sob:sob@localhost:5432/sob");
const [overlaps] = await sql`
  select count(*)::int as n
  from appointment a
  join appointment b
    on a.staff_id = b.staff_id and a.id < b.id
   and a.status <> 'cancelled' and b.status <> 'cancelled'
   and tstzrange(a.starts_at, a.ends_at, '[)') && tstzrange(b.starts_at, b.ends_at, '[)')`;
const [live] = await sql`select count(*)::int as n from appointment where status <> 'cancelled'`;
await sql.close();
console.log(JSON.stringify({ liveAppointments: live.n, overlappingPairs: overlaps.n }));
if (overlaps.n !== 0) {
  console.error(`FAIL: ${overlaps.n} overlapping pair(s)`);
  process.exit(1);
}
console.log("OK: zero overlapping appointments");
