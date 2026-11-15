import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { createClient } from "./helpers";

/**
 * Server-rendered pages under a LOW global rate limit. This spec starts its own API and web
 * server (production entry points, same Postgres/Valkey/Mailpit as the rest of the suite) with
 * `RATE_LIMIT_GLOBAL_MAX` small, because the shared stack runs with a huge limit.
 *
 * Every visitor is identified through `X-Forwarded-For` (the web server trusts it here), so each
 * browser context below is its own visitor with its own bucket.
 */
const LIMIT = 15;
const API_PORT = 3100;
const WEB_PORT = 4273;
const WEB = `http://localhost:${WEB_PORT}`;
const repoRoot = join(import.meta.dirname, "..", "..", "..");

const children: ChildProcess[] = [];
let output = "";

function start(args: string[], env: Record<string, string>) {
  const child = spawn("bun", args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-4000);
  });
  child.stderr?.on("data", (chunk) => {
    output = `${output}${chunk}`.slice(-4000);
  });
  children.push(child);
}

async function waitFor(url: string) {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} did not come up:\n${output}`);
}

/** A visitor nobody else shares: unique per test run so Valkey counters never carry over. */
let nextVisitor = 0;
const runId = Math.floor(Math.random() * 200) + 20;
const visitorAddress = () => `198.51.${runId}.${++nextVisitor}`;

test.beforeAll(async () => {
  test.setTimeout(90_000);
  const shared = {
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://sob:sob@localhost:5432/sob",
    VALKEY_URL: process.env.VALKEY_URL ?? "redis://localhost:6379",
    SALON_TIMEZONE: process.env.SALON_TIMEZONE ?? "America/Argentina/Buenos_Aires",
    BETTER_AUTH_SECRET:
      process.env.BETTER_AUTH_SECRET ?? "ci-only-secret-ci-only-secret-0123456789",
  };
  start(["apps/api/src/index.ts"], {
    ...shared,
    NODE_ENV: "production",
    PORT: String(API_PORT),
    BETTER_AUTH_URL: WEB,
    TRUSTED_ORIGINS: WEB,
    TRUST_PROXY: "true",
    NOTIFY_EMAIL_PROVIDER: "smtp",
    SMTP_URL: process.env.SMTP_URL ?? "smtp://localhost:1025",
    RATE_LIMIT_AUTH_MAX: "1000",
    RATE_LIMIT_GLOBAL_MAX: String(LIMIT),
    RATE_LIMIT_GLOBAL_WINDOW_SECONDS: "60",
  });
  start(["apps/web/server.ts"], {
    PORT: String(WEB_PORT),
    HOST: "127.0.0.1",
    API_INTERNAL_URL: `http://localhost:${API_PORT}`,
    PUBLIC_URL: WEB,
    WEB_TRUST_PROXY: "true",
  });
  await waitFor(`http://localhost:${API_PORT}/health`);
  await waitFor(`${WEB}/healthz`);
});

test.afterAll(() => {
  for (const child of children) child.kill("SIGTERM");
  children.length = 0;
});

async function visit(page: Page, path: string, headers: Record<string, string> = {}) {
  const response = await page.request.get(`${WEB}${path}`, { headers, maxRedirects: 0 });
  return { status: response.status(), retryAfter: response.headers()["retry-after"], response };
}

test.describe("SSR under a low global rate limit", () => {
  test("a visitor is served normally up to the limit, then gets a friendly 429 (never a 500)", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      baseURL: WEB,
      extraHTTPHeaders: { "x-forwarded-for": visitorAddress() },
    });
    const page = await context.newPage();
    const statuses: number[] = [];
    let last: Awaited<ReturnType<typeof visit>> | undefined;
    for (let i = 0; i < 12; i += 1) {
      last = await visit(page, "/book");
      statuses.push(last.status);
    }
    // A prefix of 200s (this visitor's budget is LIMIT calls, an SSR render of /book costs 3)...
    const firstLimited = statuses.indexOf(429);
    expect(firstLimited, statuses.join(",")).toBeGreaterThanOrEqual(3);
    expect(statuses.slice(0, firstLimited).every((s) => s === 200)).toBe(true);
    // ...then only 429s inside the window, never a 500.
    expect(
      statuses.slice(firstLimited).every((s) => s === 429),
      statuses.join(","),
    ).toBe(true);
    expect(statuses).not.toContain(500);
    expect(Number(last?.retryAfter)).toBeGreaterThanOrEqual(1);

    // The browser sees a designed page, not a stack trace.
    await page.goto("/book");
    await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible();
    await expect(page.getByText(/Please wait \d+ seconds? and try again/)).toBeVisible();
    await context.close();
  });

  test("the notice is in the visitor's language (es-AR)", async ({ browser }) => {
    const context = await browser.newContext({
      baseURL: WEB,
      locale: "es-AR",
      extraHTTPHeaders: {
        "x-forwarded-for": visitorAddress(),
        "accept-language": "es-AR,es;q=0.9",
      },
    });
    const page = await context.newPage();
    for (let i = 0; i < 8; i += 1) await visit(page, "/book");
    const response = await page.goto("/book");
    expect(response?.status()).toBe(429);
    expect(response?.headers()["retry-after"]).toBeTruthy();
    await expect(page.locator("html")).toHaveAttribute("lang", "es-AR");
    await expect(page.getByRole("heading", { name: "Demasiados intentos" })).toBeVisible();
    await expect(page.getByText(/Espera \d+ segundos? e intenta nuevamente/)).toBeVisible();
    await context.close();
  });

  test("a rate-limited signed-in user is NOT rendered or redirected as signed out", async ({
    browser,
  }) => {
    // Set the account up from another address (sign-up, mail and verification all count against
    // a bucket) and carry only its session cookie to the visitor under test.
    const setup = await playwrightRequest.newContext({
      baseURL: WEB,
      extraHTTPHeaders: { "x-forwarded-for": visitorAddress() },
    });
    await createClient(setup, WEB);
    const storageState = await setup.storageState();
    await setup.dispose();

    const context = await browser.newContext({
      baseURL: WEB,
      storageState,
      extraHTTPHeaders: { "x-forwarded-for": visitorAddress() },
    });
    const page = await context.newPage();
    const signedIn = await page.goto("/account");
    expect(signedIn?.status()).toBe(200);
    await expect(page).toHaveURL(/\/account$/);

    // Burn this visitor's remaining budget with cheap API calls.
    let limited = false;
    for (let i = 0; i < LIMIT * 2 && !limited; i += 1) {
      limited = (await page.request.get(`${WEB}/api/salon`)).status() === 429;
    }
    expect(limited).toBe(true);

    const response = await page.goto("/account");
    expect(response?.status()).toBe(429);
    expect(response?.headers()["retry-after"]).toBeTruthy();
    expect(new URL(page.url()).pathname).toBe("/account");
    await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
    await context.close();
  });

  test("distinct visitors never share a bucket", async ({ browser }) => {
    const exhausted = await browser.newContext({
      baseURL: WEB,
      extraHTTPHeaders: { "x-forwarded-for": visitorAddress() },
    });
    const exhaustedPage = await exhausted.newPage();
    for (let i = 0; i < 10; i += 1) await visit(exhaustedPage, "/book");
    expect((await visit(exhaustedPage, "/book")).status).toBe(429);

    // Ten other visitors, all fine, while the first stays limited.
    for (let i = 0; i < 10; i += 1) {
      const other = await browser.newContext({
        baseURL: WEB,
        extraHTTPHeaders: { "x-forwarded-for": visitorAddress() },
      });
      const page = await other.newPage();
      expect((await visit(page, "/book")).status, `visitor ${i}`).toBe(200);
      await other.close();
    }
    expect((await visit(exhaustedPage, "/book")).status).toBe(429);
    await exhausted.close();
  });
});
