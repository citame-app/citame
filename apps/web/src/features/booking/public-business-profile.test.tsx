import { expect, test } from "bun:test";
import {
  businessProfileContentSchema,
  diffOpeningSchedule,
  EMPTY_BUSINESS_PROFILE,
  EMPTY_OPENING_SCHEDULE,
  type OpeningSchedule,
  reviewedBusinessProfileRequestSchema,
} from "@sob/contracts";
import { screen } from "@testing-library/react";
import { renderApp } from "../../../test/render";
import { PublicBusinessProfile } from "./public-business-profile";

const timezone = "Europe/Madrid";
const morning = { startTime: "09:00", endTime: "12:00" };
const profile = businessProfileContentSchema.parse(
  Object.fromEntries(
    Object.entries(EMPTY_BUSINESS_PROFILE).filter(
      ([key]) => key !== "published" && key !== "openingSchedule",
    ),
  ),
);

test("uses a dated closure for today's hours and formats the regular hours in the visitor's locale", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const schedule: OpeningSchedule = {
    weekly: Array.from({ length: 7 }, () => [morning]),
    exceptions: [{ date: today, ranges: [] }],
  };
  renderApp(
    <PublicBusinessProfile
      profile={profile}
      openingSchedule={schedule}
      initialDate={today}
      timezone={timezone}
    />,
  );
  expect(screen.getByText("Today").parentElement).toHaveTextContent("Today · Closed");
  expect(screen.getAllByText("9:00 AM–12:00 PM")).toHaveLength(7);
});

test("preserves the distinction between deleting and closing a date and rejects overlapping edit ranges", () => {
  const base = {
    ...EMPTY_OPENING_SCHEDULE,
    exceptions: [{ date: "2026-12-24", ranges: [morning] }],
  };
  const draft = {
    ...EMPTY_OPENING_SCHEDULE,
    exceptions: [{ date: "2026-12-25", ranges: [] }],
  };
  expect(diffOpeningSchedule(base, draft)).toEqual({
    exceptions: { "2026-12-24": null, "2026-12-25": [] },
  });
  const metadata = { generation: "initial", expectedRevision: "2026-11-21T00:00:00Z" };
  expect(
    reviewedBusinessProfileRequestSchema.safeParse({
      ...metadata,
      changes: { openingScheduleEdits: { days: { "1": [morning] } } },
    }).success,
  ).toBe(true);
  expect(
    reviewedBusinessProfileRequestSchema.safeParse({
      ...metadata,
      changes: {
        openingScheduleEdits: {
          days: { "1": [morning, { startTime: "11:00", endTime: "13:00" }] },
        },
      },
    }).success,
  ).toBe(false);
});
