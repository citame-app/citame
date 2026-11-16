import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll, STYLIST_A } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

const timezone = "America/Argentina/Buenos_Aires";
const nextMonday = () => {
  let date = Temporal.Now.plainDateISO(timezone).add({ days: 7 });
  while (date.dayOfWeek !== 1) date = date.add({ days: 1 });
  return date;
};
for (const scheme of ["light", "dark"] as const) {
  test.describe(`recurring appointments — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews all dates, refreshes a conflict, creates one series and cancels only the chosen customer visit", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const created: string[] = [];
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const clients = await (
          await owner.get(`/api/admin/clients?search=${fixture.clientEmail}`)
        ).json();
        const client = clients.clients.find(
          (c: { email: string }) => c.email === fixture.clientEmail,
        );
        if (!client) throw new Error("Missing fixture customer");
        const date = nextMonday();
        const middle = date.add({ weeks: 1 });
        const startsAt = middle
          .toZonedDateTime({ timeZone: timezone, plainTime: "09:00" })
          .toInstant()
          .toString();
        const occupied = await owner.post("/api/appointments", {
          data: {
            staffId: STYLIST_A,
            clientId: client.id,
            serviceIds: [fixture.haircut],
            startsAt,
          },
        });
        expect(occupied.status(), await occupied.text()).toBe(201);
        const busy = await occupied.json();
        created.push(busy.id);
        await signInThroughUi(page, fixture.ownerEmail, `/admin/calendar?date=${date}`);
        await page.getByRole("button", { name: "New appointment", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "New appointment", exact: true });
        await dialog
          .getByLabel("Search by name, phone or email", { exact: true })
          .fill(fixture.clientEmail);
        await dialog.getByRole("radio", { name: /Recurring fixture client/ }).check();
        await dialog.getByLabel("Team member", { exact: true }).selectOption(STYLIST_A);
        await dialog.getByRole("checkbox", { name: /Haircut/ }).check();
        await dialog.getByLabel("Start time", { exact: true }).fill("09:00");
        await dialog.getByLabel("Repeat appointment", { exact: true }).selectOption("weekly");
        await dialog.getByLabel("Number of visits", { exact: true }).fill("3");
        await dialog.getByRole("button", { name: "Review recurring visits", exact: true }).click();
        const dates = dialog.getByRole("region", { name: "Recurring visit dates", exact: true });
        await expect(
          dates.getByText("Unavailable — choose a different date or time", { exact: true }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Create 3 appointments", exact: true }),
        ).toBeDisabled();
        expect(
          (
            await owner.patch(`/api/appointments/${busy.id}`, {
              data: { version: busy.version, status: "cancelled" },
            })
          ).ok(),
        ).toBe(true);
        await dates.getByRole("button", { name: "Review availability again", exact: true }).click();
        await expect(dates.getByText("Available", { exact: true })).toHaveCount(3);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `series review ${scheme}`);
        await dates.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: `/tmp/sob-series-review-${scheme}-${test.info().project.name}.png`,
        });
        const responsePromise = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments/series") && r.request().method() === "POST",
        );
        await dialog.getByRole("button", { name: "Create 3 appointments", exact: true }).click();
        const response = await responsePromise;
        expect(response.status(), await response.text()).toBe(201);
        const series = await response.json();
        expect(series.appointments).toHaveLength(3);
        created.push(...series.appointments.map((a: { id: string }) => a.id));
        await expect(page.getByText("3 appointments created", { exact: true })).toBeVisible();
        await expect(dialog).toBeHidden();
        await page
          .getByRole("button", { name: /Recurring fixture client, Haircut, Booked/ })
          .click();
        const drawer = page.getByRole("dialog", { name: "Recurring fixture client", exact: true });
        await expect(drawer.getByText("Recurring visit 1 of 3", { exact: true })).toBeVisible();
        await drawer.getByRole("button", { name: "View recurring visits", exact: true }).click();
        await expect(
          drawer
            .getByRole("region", { name: "Recurring visit dates", exact: true })
            .getByRole("listitem"),
        ).toHaveCount(3);
        await expectNoSeriousA11yViolations(page, `series calendar ${scheme}`);
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(page, fixture.clientEmail, "/account");
        const first = page.locator(`article[data-appointment-id="${series.appointments[0].id}"]`);
        const second = page.locator(`article[data-appointment-id="${series.appointments[1].id}"]`);
        await first.getByRole("button", { name: "View recurring visits", exact: true }).click();
        await expect(
          first
            .getByRole("region", { name: "Recurring visit dates", exact: true })
            .getByRole("listitem"),
        ).toHaveCount(3);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `series customer ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-series-account-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
        });
        await second.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Cancel this appointment?", exact: true })
          .getByRole("button", { name: "Yes, cancel it", exact: true })
          .click();
        await expect(second.getByText("Cancelled", { exact: true })).toBeVisible();
        await expect(
          first
            .getByRole("region", { name: "Recurring visit dates", exact: true })
            .getByText("Cancelled", { exact: true }),
        ).toBeVisible();
        const result = await (await owner.get(`/api/appointments/series/${series.id}`)).json();
        expect(result.appointments.map((a: { status: string }) => a.status)).toEqual([
          "booked",
          "cancelled",
          "booked",
        ]);
      } finally {
        for (const id of created) {
          const listing = await owner.get(
            `/api/appointments?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`,
          );
          const item = (await listing.json()).appointments.find((a: { id: string }) => a.id === id);
          if (item?.status === "booked")
            await owner.patch(`/api/appointments/${id}`, {
              data: { version: item.version, status: "cancelled" },
            });
        }
        await owner.dispose();
      }
    });
  });
}
