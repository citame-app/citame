// Read-heavy scenario: visitors browse the catalogue and look at free slots, the hot path of
// the public booking flow. No authentication, no writes.
//
//   k6 run k6/availability.js
//   BASE_URL=http://localhost:4173 API_PREFIX=/api k6 run k6/availability.js   # through the web proxy

import { check, sleep } from "k6";
import http from "k6/http";
import { dateIn, getJson, ORIGIN, ok200, url } from "./lib.js";

export const options = {
  scenarios: {
    browse: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: Number(__ENV.VUS || 50) },
        { duration: __ENV.DURATION || "40s", target: Number(__ENV.VUS || 50) },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    // The budget for the slot search the booking page waits on.
    "http_req_duration{name:availability}": ["p(95)<300"],
    "http_req_duration{name:catalogue}": ["p(95)<150"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const services = getJson("/services");
  const staff = getJson("/staff");
  const serviceList = services.services || services;
  const staffList = staff.staff || staff;
  return {
    serviceIds: serviceList.map((s) => s.id),
    staffIds: staffList.map((s) => s.id),
  };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export default function (data) {
  const headers = { Origin: ORIGIN };
  ok200(http.get(url("/services"), { headers, tags: { name: "catalogue" } }));
  ok200(http.get(url("/staff"), { headers, tags: { name: "catalogue" } }));

  // 1 to 3 services, optionally one professional, a day in the next two weeks.
  const count = 1 + Math.floor(Math.random() * 3);
  const services = [...data.serviceIds].sort(() => Math.random() - 0.5).slice(0, count);
  const staff = Math.random() < 0.5 ? `&staffId=${pick(data.staffIds)}` : "";
  const date = dateIn(1 + Math.floor(Math.random() * 14));
  const res = http.get(url(`/availability?serviceIds=${services.join(",")}&date=${date}${staff}`), {
    headers,
    tags: { name: "availability" },
  });
  check(res, {
    "availability 200 or 409": (r) => r.status === 200 || r.status === 409,
  });
  // SLEEP=0 turns the think time off: a throughput/saturation run instead of a realistic one.
  const think = Number(__ENV.SLEEP ?? 1);
  if (think > 0) sleep(think * (0.5 + Math.random()));
}
