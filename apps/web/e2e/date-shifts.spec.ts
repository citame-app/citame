import { expect, request, test } from "@playwright/test";
import { shiftDate } from "@sob/contracts";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { localDateOf } from "../src/lib/format";
import { zonedInstant } from "../src/lib/zoned";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`dated shifts — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews an occupied date, recovers an uncertain apply and refreshes a copied period after a colleague changes its source", async ({
      page,
    }) => {
      test.setTimeout(90000);
      const owner = await request.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      let staffId = "";
      let source = "";
      let booking: { id: string; version: number; startsAt: string } | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/staff");
        await page.getByRole("button", { name: "Stylist A", exact: true }).click();
        await page.getByRole("tab", { name: "Dates and shifts", exact: true }).click();
        const salon = await (await owner.get("/api/salon")).json();
        const today = localDateOf(new Date().toISOString(), salon.timezone);
        const weekday = new Date(`${today}T12:00Z`).getUTCDay();
        source = shiftDate(today, 7 - ((weekday + 6) % 7));
        const target = shiftDate(source, 7);
        staffId = (await (await owner.get("/api/admin/staff")).json()).staff.find(
          (staff: { displayName: string }) => staff.displayName === "Stylist A",
        ).id;
        const clientId = (
          await (await owner.get("/api/admin/clients?search=Recurring%20fixture%20client")).json()
        ).clients[0].id;
        const created = await owner.post("/api/appointments", {
          data: {
            staffId,
            clientId,
            serviceIds: [fixture.haircut],
            startsAt: zonedInstant(source, "09:00", salon.timezone),
          },
        });
        expect(created.status(), await created.text()).toBe(201);
        booking = await created.json();
        await page.getByLabel("Week starting", { exact: true }).fill(source);
        const monday = page.getByRole("group", { name: /^Monday,/ });
        await monday.getByLabel("Schedule mode", { exact: true }).selectOption("custom");
        await monday.getByLabel("Start 1", { exact: true }).fill("12:00");
        await monday.getByLabel("End 1", { exact: true }).fill("14:00");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `dated shift editor ${scheme}`);
        await page.getByRole("button", { name: "Review changes", exact: true }).click();
        let review = page.getByRole("dialog", { name: "Review dated shifts", exact: true });
        await expect(
          review.getByRole("heading", {
            name: "1 existing appointment no longer fits",
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          review.getByRole("link", { name: "Recurring fixture client", exact: true }),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(page, `shift conflict review ${scheme}`);
        let lost = false;
        const attempts: string[] = [];
        await page.route(`**/api/admin/staff/${staffId}/date-shifts`, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON().idempotencyKey);
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          return route.abort("failed");
        });
        await review.getByRole("button", { name: "Apply reviewed shifts", exact: true }).click();
        await expect(review.getByRole("alert")).toBeVisible();
        await review.getByRole("button", { name: "Apply reviewed shifts", exact: true }).click();
        await expect(review).toHaveCount(0);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
        const originalCalendar = await (
          await owner.get(
            `/api/appointments/calendar?from=${encodeURIComponent(zonedInstant(source, "00:00", salon.timezone))}&to=${encodeURIComponent(zonedInstant(shiftDate(source, 1), "00:00", salon.timezone))}&staffIds=${staffId}`,
          )
        ).json();
        const visit = originalCalendar.appointments.find(
          (value: { id: string }) => value.id === booking?.id,
        );
        expect(visit).toMatchObject({
          id: booking?.id,
          startsAt: booking?.startsAt,
          status: "booked",
          version: 1,
        });
        await page.getByRole("button", { name: "Copy a period", exact: true }).click();
        const copy = page.getByRole("dialog", { name: "Copy a period", exact: true });
        await copy.getByLabel("Source starts on", { exact: true }).fill(source);
        await copy.getByLabel("Days to copy", { exact: true }).fill("7");
        await copy.getByLabel("First target starts on", { exact: true }).fill(target);
        await copy.getByLabel("Number of target weeks", { exact: true }).fill("2");
        await copy.getByRole("button", { name: "Review copied dates", exact: true }).click();
        review = page.getByRole("dialog", { name: "Review dated shifts", exact: true });
        await expect(review.getByRole("listitem")).toHaveCount(14);
        const selection = {
          mode: "edit",
          changes: [{ date: source, ranges: [{ startTime: "13:00", endTime: "15:00" }] }],
        };
        const colleague = await owner.post(`/api/admin/staff/${staffId}/date-shifts/preview`, {
          data: selection,
        });
        expect(colleague.ok()).toBe(true);
        expect(
          (
            await owner.post(`/api/admin/staff/${staffId}/date-shifts`, {
              data: {
                selection,
                reviewHash: (await colleague.json()).reviewHash,
                idempotencyKey: crypto.randomUUID(),
              },
            })
          ).status(),
        ).toBe(201);
        const rejected = page.waitForResponse(
          (response) =>
            response.url().endsWith(`/api/admin/staff/${staffId}/date-shifts`) &&
            response.request().method() === "POST",
        );
        await review.getByRole("button", { name: "Apply reviewed shifts", exact: true }).click();
        expect((await rejected).status()).toBe(409);
        await expect(
          review.getByText(
            "The schedule, source hours or affected bookings changed. Refresh and review the current dates before applying.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(
          review.getByRole("button", { name: "Apply reviewed shifts", exact: true }),
        ).toBeDisabled();
        await review.getByRole("button", { name: "Refresh review", exact: true }).click();
        await expect(review.getByText("After applying: 13:00–15:00", { exact: true })).toHaveCount(
          2,
        );
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `copied date review ${scheme}`);
        const scrolling = review.getByRole("region", { name: "Review dated shifts", exact: true });
        await scrolling.focus();
        const beforeScroll = await scrolling.evaluate((element) => element.scrollTop);
        await scrolling.press("PageDown");
        await expect
          .poll(() => scrolling.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(beforeScroll);
        await review.getByRole("button", { name: "Apply reviewed shifts", exact: true }).click();
        await expect(review).toHaveCount(0);
        const dates = await (
          await owner.get(
            `/api/admin/staff/${staffId}/date-shifts?from=${target}&to=${shiftDate(target, 13)}`,
          )
        ).json();
        expect(dates.days[0].effectiveRanges).toEqual([{ startTime: "13:00", endTime: "15:00" }]);
        expect(dates.days[5].ranges).toEqual([]);
        expect(dates.days[7].effectiveRanges).toEqual([{ startTime: "13:00", endTime: "15:00" }]);
        const calendar = await (
          await owner.get(
            `/api/appointments/calendar?from=${encodeURIComponent(zonedInstant(source, "00:00", salon.timezone))}&to=${encodeURIComponent(zonedInstant(shiftDate(source, 1), "00:00", salon.timezone))}&staffIds=${staffId}`,
          )
        ).json();
        expect(calendar.workingWindows).toMatchObject([
          {
            startsAt: zonedInstant(source, "13:00", salon.timezone),
            endsAt: zonedInstant(source, "15:00", salon.timezone),
          },
        ]);
        await expect(monday.getByLabel("Start 1", { exact: true })).toHaveValue("13:00");
        await page.getByRole("radio", { name: "Español", exact: true }).check();
        await expect(
          page.getByRole("heading", { name: "Fechas y turnos", exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.getByRole("tab", { name: "Fechas y turnos", exact: true }).evaluate((tab) => {
              const bounds = tab.getBoundingClientRect();
              const list = tab.closest("[role=tablist]")?.getBoundingClientRect();
              return Boolean(
                list && bounds.left >= list.left - 1 && bounds.right <= list.right + 1,
              );
            }),
          )
          .toBe(true);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Spanish dated shifts ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-date-shifts-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
      } finally {
        if (booking)
          await owner.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        if (staffId && source) {
          const selection = {
            mode: "edit",
            changes: [
              source,
              ...Array.from({ length: 14 }, (_, index) => shiftDate(source, index + 7)),
            ].map((date) => ({ date, ranges: null })),
          };
          const reviewed = await owner.post(`/api/admin/staff/${staffId}/date-shifts/preview`, {
            data: selection,
          });
          if (reviewed.ok())
            await owner.post(`/api/admin/staff/${staffId}/date-shifts`, {
              data: {
                selection,
                reviewHash: (await reviewed.json()).reviewHash,
                idempotencyKey: crypto.randomUUID(),
              },
            });
        }
        await owner.dispose();
      }
    });
  });
