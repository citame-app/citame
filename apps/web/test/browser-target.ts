import { RECURRING_FIXTURE } from "../../api/test/recurring-values";

// Keep specialized suites ahead of the generic recurring suite if both flags are set.
const suites = [
  ["E2E_FINANCIAL_FIXTURE", ["commerce", "inventory", "accounting", "gift-cards", "passes"]],
  ["E2E_POS_FIXTURE", ["point-of-sale", "admin-management"]],
  ["E2E_CALENDAR_FIXTURE", ["calendar-workbench"]],
  ["E2E_UI_REDESIGN_FIXTURE", ["ui-redesign"]],
  ["E2E_MERGE_FIXTURE", ["client-merge"]],
  ["E2E_BOOKING_PROMOTIONS_FIXTURE", ["booking-promotions"]],
  ["E2E_TIMED_PROMOTIONS_FIXTURE", ["timed-promotions"]],
  ["E2E_PROCESSING_FIXTURE", ["processing"]],
  ["E2E_COMBINATIONS_FIXTURE", ["combinations"]],
  ["E2E_SOCIAL_FIXTURE", ["social-creative"]],
  ["E2E_ACQUISITION_FIXTURE", ["acquisition"]],
  ["E2E_REPUTATION_FIXTURE", ["reputation", "portfolio", "staff-portrait"]],
  ["E2E_SHIFTS_FIXTURE", ["date-shifts"]],
  ["E2E_INTAKE_FIXTURE", ["intake"]],
  ["E2E_CRM_FIXTURE", ["client-transfer", "client-photos"]],
  ["E2E_OPTIONS_FIXTURE", ["service-options"]],
  ["E2E_RESOURCES_FIXTURE", ["resources"]],
  ["E2E_WAITLIST_FIXTURE", ["waitlist"]],
  ["E2E_SERIES_FIXTURE", ["appointment-series"]],
  ["E2E_REWARDS_FIXTURE", ["rewards"]],
  ["E2E_DEPOSIT_FIXTURE", ["booking-protection"]],
  ["E2E_RECURRING_FIXTURE", ["recurring"]],
] as const;

export const browserFixture = suites
  .find(([flag]) => process.env[flag] === "true")?.[1]
  .map((spec) => `**/${spec}.spec.ts`);

// Financial specs prepare their own data and can also run against the default test stack.
export const fixtureOnlyTests = suites
  .filter(([flag]) => flag !== "E2E_FINANCIAL_FIXTURE")
  .flatMap(([, specs]) => specs.map((spec) => `**/${spec}.spec.ts`));

// A managed suite must never sign in to a different stack through an inherited override.
export const browserTarget = browserFixture
  ? RECURRING_FIXTURE
  : {
      baseURL: process.env.E2E_BASE_URL ?? "http://localhost:4173",
      ownerEmail: process.env.E2E_OWNER_EMAIL ?? "owner@example.com",
      password: process.env.E2E_OWNER_PASSWORD ?? RECURRING_FIXTURE.password,
    };
