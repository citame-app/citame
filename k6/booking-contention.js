// Many virtual users race for the SAME slot. The database exclusion constraint is the source of
// truth, so for every slot exactly one request must get 201 and every other one 409 slot_taken.
// Afterwards `bun k6/check-overlaps.ts` confirms in SQL that no two live appointments overlap.
//
//   K6_EMAIL=owner@example.com K6_PASSWORD=... k6 run k6/booking-contention.js && bun k6/check-overlaps.ts
//
// Bookings are made as the owner (who may book for any client), so no client sign-ups are
// needed; the load on the booking transaction is identical.

import exec from "k6/execution";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { dateIn, getJson, JSON_HEADERS, signIn, url } from "./lib.js";

const ROUNDS = Number(__ENV.ROUNDS || 10);
const VUS = Number(__ENV.VUS || 50);

const created = new Counter("contention_created");
const slotTaken = new Counter("contention_slot_taken");
const unexpected = new Counter("contention_unexpected");
const violations = new Counter("contention_slot_violations");

const scenarios = {};
for (let r = 0; r < ROUNDS; r++) {
  scenarios[`round_${r}`] = {
    executor: "per-vu-iterations",
    vus: VUS,
    iterations: 1,
    startTime: `${r * 4}s`,
    maxDuration: "30s",
    exec: "race",
    env: { ROUND: String(r) },
  };
}

export const options = {
  scenarios,
  thresholds: {
    contention_created: [`count==${ROUNDS}`],
    contention_slot_taken: [`count==${ROUNDS * (VUS - 1)}`],
    contention_unexpected: ["count==0"],
    contention_slot_violations: ["count==0"],
    // A losing booking must still be answered quickly: it is a constraint violation, not a timeout.
    "http_req_duration{name:book}": ["p(95)<1000"],
  },
};

export function setup() {
  const cookie = signIn(__ENV.K6_EMAIL || "owner@example.com", __ENV.K6_PASSWORD || "");
  const headers = { Origin: JSON_HEADERS.Origin, Cookie: cookie };
  const services = getJson("/services");
  const staff = getJson("/staff");
  const service = (services.services || services)[0];
  const stylist = (staff.staff || staff)[0];
  const clients = http.get(url("/admin/clients?pageSize=1"), { headers });
  const clientList = clients.json();
  const client = (clientList.clients || clientList.items || clientList)[0];
  if (!client) throw new Error("need at least one client profile (run the seed)");

  // Non-overlapping free slots, one per round, taken from the real availability search.
  const slots = [];
  for (let day = 2; slots.length < ROUNDS && day < 60; day++) {
    const res = getJson(
      `/availability?serviceIds=${service.id}&staffId=${stylist.id}&date=${dateIn(day)}`,
    );
    let lastEnd = 0;
    for (const slot of res.slots) {
      if (slots.length >= ROUNDS) break;
      const start = Date.parse(slot.startsAt);
      if (start >= lastEnd) {
        slots.push({ startsAt: slot.startsAt, endsAt: slot.endsAt });
        lastEnd = Date.parse(slot.endsAt);
      }
    }
  }
  if (slots.length < ROUNDS) throw new Error(`only ${slots.length} free slots found`);
  return { cookie, serviceId: service.id, staffId: stylist.id, clientId: client.id, slots };
}

export function race(data) {
  const round = Number(__ENV.ROUND);
  const slot = data.slots[round];
  const res = http.post(
    url("/appointments"),
    JSON.stringify({
      staffId: data.staffId,
      serviceIds: [data.serviceId],
      startsAt: slot.startsAt,
      clientId: data.clientId,
    }),
    { headers: { ...JSON_HEADERS, Cookie: data.cookie }, tags: { name: "book" } },
  );
  if (res.status === 201) created.add(1);
  else if (res.status === 409 && res.json("error.code") === "slot_taken") slotTaken.add(1);
  else {
    unexpected.add(1);
    console.error(`unexpected ${res.status}: ${res.body} (vu ${exec.vu.idInTest})`);
  }
}

export function teardown(data) {
  // Independent of what the responses said: exactly one live appointment per raced slot.
  const headers = { Origin: JSON_HEADERS.Origin, Cookie: data.cookie };
  data.slots.forEach((slot) => {
    const day = slot.startsAt.slice(0, 10);
    const from = new Date(Date.parse(day) - 86400000).toISOString();
    const to = new Date(Date.parse(day) + 2 * 86400000).toISOString();
    const res = http.get(
      url(`/appointments?staffId=${data.staffId}&from=${from}&to=${to}&pageSize=100`),
      { headers },
    );
    const list = res.json();
    const items = list.appointments || list.items || list;
    const live = items.filter((a) => a.startsAt === slot.startsAt && a.status !== "cancelled");
    if (live.length !== 1) {
      violations.add(1);
      console.error(`slot ${slot.startsAt}: ${live.length} live appointments`);
    }
  });
}
