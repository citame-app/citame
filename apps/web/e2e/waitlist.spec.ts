import { expect, type Page, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll, STYLIST_A } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

const timezone = "America/Argentina/Buenos_Aires";
const nextMonday = () => {
  let date = Temporal.Now.plainDateISO(timezone).add({ days: 7 });
  while (date.dayOfWeek !== 1) date = date.add({ days: 1 });
  return date;
};
async function join(page: Page, date: string) {
  await page.getByRole("button", { name: "Join the waitlist", exact: true }).click();
  const form = page.getByRole("form", { name: "New waitlist request", exact: true });
  await form.getByRole("checkbox", { name: /Haircut/ }).check();
  await form.getByLabel("Preferred team member", { exact: true }).selectOption(STYLIST_A);
  await form.getByLabel("From date", { exact: true }).fill(date);
  await form.getByLabel("Until date", { exact: true }).fill(date);
  await form.getByLabel("Earliest start", { exact: true }).fill("09:00");
  await form.getByLabel("Latest finish", { exact: true }).fill("10:00");
  const responsePromise = page.waitForResponse(
    (r) => r.url().endsWith("/api/me/waitlist") && r.request().method() === "POST",
  );
  await form.getByRole("button", { name: "Save waitlist request", exact: true }).click();
  const response = await responsePromise;
  expect(response.status(), await response.text()).toBe(201);
  await expect(form).toBeHidden();
  return await response.json();
}
for (const scheme of ["light", "dark"] as const) {
  test.describe(`waitlist — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("joins, receives a private hold, explicitly accepts deposit terms, and releases a later expired offer", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const clientEmail = `waitlist-${crypto.randomUUID()}@fixture.test`;
      const entries: string[] = [];
      let appointmentId: string | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const signup = await playwrightRequest.newContext({
          baseURL: fixture.baseURL,
          extraHTTPHeaders: { origin: fixture.baseURL },
        });
        try {
          const response = await signup.post("/api/auth/sign-up/email", {
            data: {
              email: clientEmail,
              name: "Waitlist fixture client",
              password: fixture.password,
            },
          });
          expect(response.status(), await response.text()).toBe(200);
        } finally {
          await signup.dispose();
        }
        const policy = await (await owner.get("/api/admin/settings/booking-policy")).json();
        expect(
          (
            await owner.put("/api/admin/settings/booking-policy", {
              data: {
                ...policy,
                enabled: true,
                depositKind: "percent",
                depositValue: 2500,
                cancellationWindowMinutes: 1440,
                lateCancellationBasisPoints: 0,
                noShowBasisPoints: 0,
              },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/waitlist");
        const settings = page.getByRole("form", { name: "Waitlist policy", exact: true });
        await settings
          .getByRole("checkbox", { name: "Enable new waitlist requests and offers", exact: true })
          .check();
        await settings.getByLabel("Offer validity (minutes)", { exact: true }).fill("10");
        await settings.getByRole("button", { name: "Save waitlist policy", exact: true }).click();
        await expect(settings.getByText("Waitlist policy saved", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `waitlist owner ${scheme}`);
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        const date = nextMonday();
        await signInThroughUi(
          page,
          clientEmail,
          `/account/waitlist?services=${fixture.haircut}&staff=${STYLIST_A}&date=${date}`,
        );
        await expect(
          page.getByRole("heading", { name: "Waitlist", exact: true, level: 1 }),
        ).toBeVisible();
        await expect(page).toHaveTitle(/Waitlist/);
        const first = await join(page, date.toString());
        entries.push(first.id);
        expect(
          (
            await owner.post("/api/__recurring-fixture/waitlist/run", {
              headers: { "x-recurring-fixture": "local-only" },
              data: {},
            })
          ).ok(),
        ).toBe(true);
        await page.getByRole("button", { name: "Refresh requests", exact: true }).click();
        const card = page.locator(`li[data-waitlist-id="${first.id}"]`);
        await expect(card.getByText("A time is reserved for you", { exact: true })).toBeVisible();
        await expect(card.getByText("With Stylist A", { exact: true })).toBeVisible();
        const held = await (await owner.get("/api/me/waitlist")).json();
        expect(held.error).toBeDefined();
        await page.getByRole("radio", { name: "Español", exact: true }).check({ force: true });
        await expect(
          page.getByRole("heading", { name: "Lista de espera", exact: true, level: 1 }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `waitlist Spanish ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-waitlist-es-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        await page.getByRole("radio", { name: "English", exact: true }).check({ force: true });
        await card.getByRole("button", { name: "Review this offer", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Review waitlist offer", exact: true });
        const accept = review.getByRole("button", {
          name: "Accept and book this time",
          exact: true,
        });
        await expect(accept).toBeDisabled();
        await review
          .getByRole("checkbox", {
            name: "I accept this deposit and cancellation policy.",
            exact: true,
          })
          .check();
        await expect(accept).toBeEnabled();
        await expectNoSeriousA11yViolations(page, `waitlist consent ${scheme}`);
        await expectNoHorizontalScroll(page);
        await page.screenshot({
          path: `/tmp/sob-waitlist-review-${scheme}-${test.info().project.name}.png`,
          animations: "disabled",
        });
        const acceptedResponse = page.waitForResponse(
          (r) =>
            r.url().endsWith(`/api/me/waitlist/${first.id}/accept`) &&
            r.request().method() === "POST",
        );
        await accept.click();
        const accepted = await acceptedResponse;
        expect(accepted.status(), await accepted.text()).toBe(201);
        const booked = await accepted.json();
        appointmentId = booked.appointment.id;
        expect(booked.appointment.protection).toMatchObject({
          state: "pending",
          depositCents: 500,
        });
        await expect(review).toBeHidden();
        await expect(page.getByText("Deposit awaiting payment", { exact: true })).toBeVisible();
        const second = await join(page, date.add({ weeks: 1 }).toString());
        entries.push(second.id);
        expect(
          (
            await owner.post("/api/__recurring-fixture/waitlist/run", {
              headers: { "x-recurring-fixture": "local-only" },
              data: {},
            })
          ).ok(),
        ).toBe(true);
        const offered = (await (await owner.get("/api/admin/waitlist")).json()).entries.find(
          (e: { id: string }) => e.id === second.id,
        );
        expect(offered.offer).toBeTruthy();
        expect(
          (
            await owner.post("/api/__recurring-fixture/waitlist/run", {
              headers: { "x-recurring-fixture": "local-only" },
              data: { expireOfferId: offered.offer.id },
            })
          ).ok(),
        ).toBe(true);
        await page.getByRole("button", { name: "Refresh requests", exact: true }).click();
        const released = page.locator(`li[data-waitlist-id="${second.id}"]`);
        await expect(
          released.getByText("Waiting for a suitable time", { exact: true }),
        ).toBeVisible();
        await expect(
          released.getByRole("button", { name: "Review this offer", exact: true }),
        ).toHaveCount(0);
        const free = await (
          await owner.get(
            `/api/availability?date=${date.add({ weeks: 1 })}&staffId=${STYLIST_A}&serviceIds=${fixture.haircut}`,
          )
        ).json();
        expect(
          free.slots.some((s: { startsAt: string }) => s.startsAt === offered.offer.startsAt),
        ).toBe(true);
        await released
          .getByRole("button", { name: "Cancel waitlist request", exact: true })
          .click();
        await page
          .getByRole("dialog", { name: "Cancel this waitlist request?", exact: true })
          .getByRole("button", { name: "Yes, leave the waitlist", exact: true })
          .click();
        await expect(released.getByText("Request cancelled", { exact: true })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `waitlist complete ${scheme}`);
      } finally {
        for (const id of entries) {
          const list = await (await owner.get("/api/admin/waitlist")).json();
          const entry = list.entries?.find((e: { id: string }) => e.id === id);
          if (entry && ["waiting", "offered"].includes(entry.state))
            await owner.post(`/api/admin/waitlist/${id}/cancel`, {
              data: { version: entry.version },
            });
        }
        if (appointmentId) {
          const list = await (
            await owner.get("/api/appointments?from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z")
          ).json();
          const a = list.appointments?.find((a: { id: string }) => a.id === appointmentId);
          if (a?.status === "booked")
            await owner.patch(`/api/appointments/${a.id}`, {
              data: { version: a.version, status: "cancelled" },
            });
        }
        await owner.dispose();
      }
    });
  });
}
