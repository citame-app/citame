import {
  type APIRequestContext,
  expect,
  type Page,
  type PlaywrightWorkerArgs,
  request as pwRequest,
} from "@playwright/test";
import { PASSWORD, signInThroughUi } from "./helpers";

export const OWNER_EMAIL = process.env.E2E_OWNER_EMAIL ?? "owner@example.com";
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:4173";
export const STYLIST_A = "0198f5a0-7b1c-7000-8000-000000000201";
export const STYLIST_B = "0198f5a0-7b1c-7000-8000-000000000202";
export const HAIRCUT = "0198f5a0-7b1c-7000-8000-000000000101";
export const BLOW_DRY = "0198f5a0-7b1c-7000-8000-000000000102";
export const TZ = "America/Argentina/Buenos_Aires";

const origin = new URL(BASE_URL).origin;

/** An API client that is signed in (cookies kept in the context), talking to the web origin like a browser. */
export async function apiAs(email: string, password = PASSWORD): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { origin } });
  const res = await ctx.post("/api/auth/sign-in/email", { data: { email, password } });
  expect(res.ok(), await res.text()).toBe(true);
  return ctx;
}

export const asOwner = () => apiAs(OWNER_EMAIL);

/** `YYYY-MM-DD` of today in the salon timezone plus `days`. */
export function salonDate(days = 0): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

/** The first date at least `from` days away (negative: in the past) that falls on one of `weekdays`. */
export function nextWeekday(
  from: number,
  weekdays: number[] = [1, 2, 3, 4],
  step: 1 | -1 = 1,
): string {
  let days = from;
  while (!weekdays.includes(weekdayOf(salonDate(days)))) days += step;
  return salonDate(days);
}

/** The instant for a salon-local wall-clock time (Buenos Aires has no DST: UTC-3). */
export const at = (date: string, time: string) =>
  new Date(`${date}T${time}:00-03:00`).toISOString();

export async function createClientProfile(owner: APIRequestContext, name: string) {
  const res = await owner.post("/api/appointments", {
    data: {
      staffId: STYLIST_B,
      serviceIds: [HAIRCUT],
      startsAt: at(nextWeekday(40, [1]), "09:00"),
      client: { name },
      override: true,
    },
  });
  return res;
}

export async function book(
  owner: APIRequestContext,
  options: { staffId?: string; serviceIds?: string[]; date: string; time: string; client: string },
) {
  const res = await owner.post("/api/appointments", {
    data: {
      staffId: options.staffId ?? STYLIST_A,
      serviceIds: options.serviceIds ?? [HAIRCUT],
      startsAt: at(options.date, options.time),
      client: { name: options.client },
      override: true,
    },
  });
  if (res.status() === 409) return null;
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { id: string; version: number; clientId: string };
}

export async function setStatus(
  owner: APIRequestContext,
  id: string,
  version: number,
  status: string,
) {
  const res = await owner.patch(`/api/appointments/${id}`, { data: { version, status } });
  expect(res.ok(), await res.text()).toBe(true);
}

/** Creates (once) a staff account whose calendar performs the haircut and works Mon-Fri 09-18. */
export async function ensureStaff(
  email: string,
  displayName: string,
): Promise<{ staffId: string }> {
  const owner = await asOwner();
  const created = await owner.post("/api/admin/staff-accounts", {
    data: { email, name: displayName, password: PASSWORD, displayName },
  });
  let staffId: string;
  if (created.status() === 201) {
    staffId = ((await created.json()) as { staffId: string }).staffId;
  } else {
    const list = (await (await owner.get("/api/admin/staff")).json()) as {
      staff: { id: string; displayName: string }[];
    };
    staffId = (list.staff.find((s) => s.displayName === displayName) as { id: string }).id;
  }
  const svc = (await (await owner.get("/api/admin/services")).json()) as {
    services: { id: string; staffIds: string[] }[];
  };
  const haircut = svc.services.find((s) => s.id === HAIRCUT) as { id: string; staffIds: string[] };
  if (!haircut.staffIds.includes(staffId)) {
    await owner.put(`/api/admin/services/${HAIRCUT}/staff`, {
      data: { staffIds: [...haircut.staffIds, staffId] },
    });
  }
  await owner.put(`/api/admin/staff/${staffId}/working-hours`, {
    data: {
      hours: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })),
    },
  });
  await owner.dispose();
  return { staffId };
}

export async function signInAs(page: Page, email: string, redirect = "/admin") {
  await signInThroughUi(page, email, redirect);
  const path = redirect.split("?")[0] as string;
  await page.waitForURL((url) => url.pathname === path);
}

export type Playwright = PlaywrightWorkerArgs["playwright"];

/** Fails the test when the page produced a horizontal scrollbar (the body must never scroll sideways). */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal page scroll").toBeLessThanOrEqual(1);
}

/**
 * Distinct weekday dates for one run, starting at a random offset so repeated runs against the
 * same database rarely land on a slot a previous run booked. Positive: future, negative: past.
 */
export function runDays(count: number, direction: 1 | -1 = 1, weekdays = [1, 2, 3, 4]): string[] {
  const start = 3 + Math.floor(Math.random() * 40);
  const dates: string[] = [];
  let offset = direction * start;
  while (dates.length < count) {
    const date = salonDate(offset);
    if (weekdays.includes(weekdayOf(date))) dates.push(date);
    offset += direction;
  }
  return dates;
}

/** The first hour (09..16) where Stylist A is free for `span` consecutive hours on `date`. */
export async function freeHour(date: string, span = 1): Promise<number> {
  const owner = await asOwner();
  const res = await owner.get("/api/appointments/calendar", {
    params: { from: at(date, "00:00"), to: at(date, "23:59"), staffIds: STYLIST_A },
  });
  const body = (await res.json()) as {
    appointments: { startsAt: string; endsAt: string; status: string }[];
  };
  const busy = body.appointments
    .filter((a) => a.status !== "cancelled")
    .map((a) => [Date.parse(a.startsAt), Date.parse(a.endsAt)] as const);
  const offset = Math.floor(Math.random() * 4);
  for (let i = 0; i < 8; i++) {
    const h = 9 + ((i + offset) % 8);
    if (h + span > 17) continue;
    const from = Date.parse(at(date, `${String(h).padStart(2, "0")}:00`));
    const to = from + span * 3_600_000;
    if (!busy.some(([a, b]) => a < to && b > from)) return h;
  }
  throw new Error(`no free ${span}h block for Stylist A on ${date}`);
}
