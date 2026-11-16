import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against a REAL stack: Postgres, Valkey, the Hono API and the built web
 * server (see README, "End-to-end tests"). Nothing is mocked except where a test says so.
 */
const optionsFixture = process.env.E2E_OPTIONS_FIXTURE === "true";
const crmFixture = process.env.E2E_CRM_FIXTURE === "true";
const intakeFixture = process.env.E2E_INTAKE_FIXTURE === "true";
const shiftsFixture = process.env.E2E_SHIFTS_FIXTURE === "true";
const bookingPromotionsFixture = process.env.E2E_BOOKING_PROMOTIONS_FIXTURE === "true";
const timedPromotionsFixture = process.env.E2E_TIMED_PROMOTIONS_FIXTURE === "true";
const processingFixture = process.env.E2E_PROCESSING_FIXTURE === "true";
const combinationFixture = process.env.E2E_COMBINATIONS_FIXTURE === "true";
const socialFixture = process.env.E2E_SOCIAL_FIXTURE === "true";
const acquisitionFixture = process.env.E2E_ACQUISITION_FIXTURE === "true";
const productionWeb = process.env.E2E_WEB_IMAGE === "true";
const reputationFixture = process.env.E2E_REPUTATION_FIXTURE === "true";
const resourcesFixture = process.env.E2E_RESOURCES_FIXTURE === "true";
const depositFixture = process.env.E2E_DEPOSIT_FIXTURE === "true";
const waitlistFixture = process.env.E2E_WAITLIST_FIXTURE === "true";
const seriesFixture = process.env.E2E_SERIES_FIXTURE === "true";
const rewardsFixture = process.env.E2E_REWARDS_FIXTURE === "true";
const recurringFixture =
  process.env.E2E_RECURRING_FIXTURE === "true" ||
  depositFixture ||
  rewardsFixture ||
  seriesFixture ||
  waitlistFixture ||
  resourcesFixture ||
  optionsFixture ||
  crmFixture ||
  intakeFixture ||
  shiftsFixture ||
  reputationFixture ||
  acquisitionFixture ||
  socialFixture ||
  combinationFixture ||
  processingFixture ||
  timedPromotionsFixture ||
  bookingPromotionsFixture;
const baseURL = recurringFixture
  ? "http://localhost:4273"
  : (process.env.E2E_BASE_URL ?? "http://localhost:4173");

export default defineConfig({
  testDir: "./e2e",
  ...(recurringFixture
    ? {
        testMatch: bookingPromotionsFixture
          ? "**/booking-promotions.spec.ts"
          : timedPromotionsFixture
            ? "**/timed-promotions.spec.ts"
            : processingFixture
              ? "**/processing.spec.ts"
              : combinationFixture
                ? "**/combinations.spec.ts"
                : socialFixture
                  ? "**/social-creative.spec.ts"
                  : acquisitionFixture
                    ? "**/acquisition.spec.ts"
                    : reputationFixture
                      ? ["**/reputation.spec.ts", "**/portfolio.spec.ts"]
                      : shiftsFixture
                        ? "**/date-shifts.spec.ts"
                        : intakeFixture
                          ? "**/intake.spec.ts"
                          : crmFixture
                            ? ["**/client-transfer.spec.ts", "**/client-photos.spec.ts"]
                            : optionsFixture
                              ? "**/service-options.spec.ts"
                              : resourcesFixture
                                ? "**/resources.spec.ts"
                                : waitlistFixture
                                  ? "**/waitlist.spec.ts"
                                  : seriesFixture
                                    ? "**/appointment-series.spec.ts"
                                    : rewardsFixture
                                      ? "**/rewards.spec.ts"
                                      : depositFixture
                                        ? "**/booking-protection.spec.ts"
                                        : "**/recurring.spec.ts",
        webServer: [
          {
            command: "NODE_ENV=test bun ../api/test/recurring-browser.ts",
            url: "http://localhost:4300/health",
            reuseExistingServer: false,
            timeout: 60000,
          },
          {
            command: productionWeb
              ? "NODE_ENV=test bun test/production-web.ts"
              : `API_INTERNAL_URL=http://localhost:4300 PORT=4273 PUBLIC_URL=http://localhost:4273 ${acquisitionFixture ? "BOOKING_WIDGET_ORIGINS=http://localhost:4274,http://127.0.0.1:4274 " : ""}bun server.ts`,
            url: "http://localhost:4273/healthz",
            ...(productionWeb
              ? { gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10000 } }
              : {}),
            reuseExistingServer: false,
            timeout: 60000,
          },
        ],
      }
    : {
        testIgnore: [
          "**/recurring.spec.ts",
          "**/booking-protection.spec.ts",
          "**/rewards.spec.ts",
          "**/appointment-series.spec.ts",
          "**/waitlist.spec.ts",
          "**/resources.spec.ts",
          "**/service-options.spec.ts",
          "**/combinations.spec.ts",
          "**/processing.spec.ts",
          "**/timed-promotions.spec.ts",
          "**/booking-promotions.spec.ts",
          "**/client-transfer.spec.ts",
          "**/client-photos.spec.ts",
          "**/intake.spec.ts",
          "**/date-shifts.spec.ts",
          "**/social-creative.spec.ts",
          "**/acquisition.spec.ts",
          "**/reputation.spec.ts",
          "**/portfolio.spec.ts",
        ],
      }),
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
