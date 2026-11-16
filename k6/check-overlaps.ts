// SQL proof of active professional capacity after a contention run.
// Full client spans may overlap during processing or explicitly configured concurrent work.
import { SQL } from "bun";

const sql = new SQL(process.env.DATABASE_URL ?? "postgres://sob:sob@localhost:5432/sob");
const [overlaps] =
  await sql`select count(*)::int as n from staff_reservation a join staff_reservation b on a.staff_id=b.staff_id and a.unit_index=b.unit_index and a.id<b.id and a.active and b.active and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')`;
const [capacity] =
  await sql`select count(*)::int as n from staff_reservation r join staff_profile s on s.id=r.staff_id where r.active and r.ends_at>s.capacity_effective_at and r.unit_index>=s.max_concurrent`;
const [spans] =
  await sql`select count(*)::int as n from appointment a join appointment b on a.staff_id=b.staff_id and a.id<b.id and a.status<>'cancelled' and b.status<>'cancelled' and a.deleted_at is null and b.deleted_at is null and tstzrange(a.starts_at,a.ends_at,'[)') && tstzrange(b.starts_at,b.ends_at,'[)')`;
const [live] =
  await sql`select count(*)::int as n from appointment where status<>'cancelled' and deleted_at is null`;
await sql.close();
console.log(
  JSON.stringify({
    liveAppointments: live.n,
    overlappingPairs: overlaps.n,
    appointmentSpanOverlaps: spans.n,
    capacityLimitViolations: capacity.n,
  }),
);
if (overlaps.n !== 0 || capacity.n !== 0) {
  console.error(`FAIL: ${overlaps.n} active unit overlap(s), ${capacity.n} capacity violation(s)`);
  process.exit(1);
}
console.log("OK: zero active professional capacity violations");
