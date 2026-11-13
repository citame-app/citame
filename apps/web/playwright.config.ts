import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a REAL stack: Postgres, Valkey, the Hono API and the built web
 * server (see README, "End-to-end tests"). Nothing is mocked except where a test says so.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:4173";

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results",
  // Tests share one database and one rate limiter: run them one at a time, in a stable order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL,
    locale: "en",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
