import { defineConfig, devices } from "@playwright/test";
import { RECURRING_FIXTURE } from "../api/test/recurring-values";
import { browserFixture, browserTarget, fixtureOnlyTests } from "./test/browser-target";

/**
 * End-to-end tests run against a REAL stack: Postgres, Valkey, the Hono API and the built web
 * server (see README, "End-to-end tests"). Nothing is mocked except where a test says so.
 */
const acquisitionFixture = process.env.E2E_ACQUISITION_FIXTURE === "true";
const productionWeb = process.env.E2E_WEB_IMAGE === "true";

export default defineConfig({
  testDir: "./e2e",
  ...(browserFixture
    ? {
        testMatch: browserFixture,
        webServer: [
          {
            command: "NODE_ENV=test bun ../api/test/recurring-browser.ts",
            url: `http://localhost:${RECURRING_FIXTURE.apiPort}/health`,
            reuseExistingServer: false,
            timeout: 60000,
          },
          {
            command: productionWeb
              ? "NODE_ENV=test bun test/production-web.ts"
              : `API_INTERNAL_URL=http://localhost:${RECURRING_FIXTURE.apiPort} HOST=127.0.0.1 PORT=${new URL(browserTarget.baseURL).port} PUBLIC_URL=${browserTarget.baseURL} ${acquisitionFixture ? "BOOKING_WIDGET_ORIGINS=http://localhost:4274,http://127.0.0.1:4274 " : ""}bun server.ts`,
            url: `${browserTarget.baseURL}/healthz`,
            ...(productionWeb
              ? {
                  gracefulShutdown: {
                    signal: "SIGTERM" as const,
                    timeout: 10000,
                  },
                }
              : {}),
            reuseExistingServer: false,
            timeout: 60000,
          },
        ],
      }
    : { testIgnore: fixtureOnlyTests }),
  outputDir: "./test-results",
  // Tests share one database and one rate limiter: run them one at a time, in a stable order.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: browserTarget.baseURL,
    locale: "en",
    timezoneId: "America/Argentina/Buenos_Aires",
    trace: "retain-on-failure",
    reducedMotion: "reduce",
  },
  projects: [
    { name: "mobile", use: { ...devices["Pixel 7"], browserName: "chromium" } },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
