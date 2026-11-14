// Shared helpers for the k6 scenarios. Plain k6 JavaScript (no bundler, no imports from npm).

import { check, fail } from "k6";
import http from "k6/http";

// BASE_URL is the API directly (default) or the web origin; API_PREFIX is "" for the API and
// "/api" through the web server's same-origin proxy. Better Auth always lives under /api/auth.
export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
export const API_PREFIX = __ENV.API_PREFIX || "";
export const ORIGIN = __ENV.ORIGIN || BASE_URL;

export const url = (path) => `${BASE_URL}${API_PREFIX}${path}`;
export const authUrl = (path) => `${BASE_URL}/api/auth${path}`;

export const JSON_HEADERS = { "Content-Type": "application/json", Origin: ORIGIN };

/** Signs in and returns a Cookie header value. Run it in setup(): VUs share the session. */
export function signIn(email, password) {
  const res = http.post(authUrl("/sign-in/email"), JSON.stringify({ email, password }), {
    headers: JSON_HEADERS,
  });
  if (res.status !== 200) fail(`sign-in failed (${res.status}): ${res.body}`);
  const cookies = res.cookies;
  return Object.keys(cookies)
    .map((name) => `${name}=${cookies[name][0].value}`)
    .join("; ");
}

export function getJson(path, params = {}) {
  const res = http.get(url(path), { headers: { Origin: ORIGIN }, ...params });
  if (res.status !== 200) fail(`GET ${path} -> ${res.status}: ${res.body}`);
  return res.json();
}

/** `YYYY-MM-DD` in UTC, `days` from today. The salon is UTC-3: noon avoids day-edge surprises. */
export function dateIn(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

export function ok200(res) {
  return check(res, { "status is 200": (r) => r.status === 200 });
}
