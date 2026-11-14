// Smoke-sized mixed workload: mostly browsing, a few bookings and reads of the staff schedule,
// plus the health probes. Meant for "does the stack hold together", not for finding limits.

import { check, sleep } from "k6";
import http from "k6/http";
import { dateIn, getJson, JSON_HEADERS, ok200, signIn, url } from "./lib.js";

export const options = {
  scenarios: {
    browsers: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 20),
      duration: __ENV.DURATION || "30s",
      exec: "browse",
    },
    front_desk: {
      executor: "constant-vus",
      vus: 2,
      duration: __ENV.DURATION || "30s",
      exec: "desk",
    },
    probes: {
      executor: "constant-arrival-rate",
      rate: 5,
      timeUnit: "1s",
      duration: __ENV.DURATION || "30s",
      preAllocatedVUs: 1,
      exec: "probe",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<500"],
    "http_req_duration{name:ready}": ["p(95)<100"],
    checks: ["rate>0.99"],
  },
};

export function setup() {
  const cookie = signIn(__ENV.K6_EMAIL || "owner@example.com", __ENV.K6_PASSWORD || "");
  const services = getJson("/services");
  const staff = getJson("/staff");
  return {
    cookie,
    serviceIds: (services.services || services).map((s) => s.id),
    staffIds: (staff.staff || staff).map((s) => s.id),
  };
}

export function browse(data) {
  const service = data.serviceIds[Math.floor(Math.random() * data.serviceIds.length)];
  ok200(http.get(url("/services"), { tags: { name: "catalogue" } }));
  const res = http.get(
    url(`/availability?serviceIds=${service}&date=${dateIn(1 + Math.floor(Math.random() * 10))}`),
    { tags: { name: "availability" } },
  );
  check(res, { "availability ok": (r) => r.status === 200 || r.status === 409 });
  sleep(1);
}

export function desk(data) {
  const headers = { ...JSON_HEADERS, Cookie: data.cookie };
  const from = new Date().toISOString();
  const to = new Date(Date.now() + 7 * 86400000).toISOString();
  ok200(
    http.get(url(`/appointments/calendar?from=${from}&to=${to}`), {
      headers,
      tags: { name: "calendar" },
    }),
  );
  ok200(http.get(url("/sync/pull?since=0&limit=100"), { headers, tags: { name: "sync_pull" } }));
  sleep(1);
}

export function probe() {
  ok200(http.get(url("/ready"), { tags: { name: "ready" } }));
}
