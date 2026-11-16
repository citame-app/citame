import { expect, test } from "@playwright/test";
import {
  createClient,
  PASSWORD,
  pickFirstTime,
  pickProfessional,
  SERVICES,
  startBooking,
  uniqueEmail,
} from "./helpers";
import { firstLink, pathOf, waitForMail } from "./mail";

test.describe("public booking flow", () => {
  test("a new visitor books from the home page to the confirmation, signing up inline", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your beauty salon.");
    await page.getByRole("link", { name: "Book an appointment" }).first().click();
    await expect(page).toHaveURL(/\/book$/);

    // Services: multi-select with a running total.
    await page.getByRole("checkbox", { name: new RegExp(SERVICES.haircut) }).check();
    await page.getByRole("checkbox", { name: new RegExp(SERVICES.blowDry) }).check();
    const summary = page.getByRole("complementary", { name: "Your booking" });
    await expect(summary).toContainText("2 services");
    await expect(summary).toContainText("1h 15m");
    await page.getByRole("button", { name: "Continue" }).click();

    // Professional: "any available" is offered next to eligible people only.
    await expect(page).toHaveURL(/\/book\/professional/);
    await expect(page.getByRole("radio", { name: "Any available professional" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Stylist B/ })).toHaveCount(0);
    await pickProfessional(page, "Any available professional");

    // Time: groups in the salon timezone, the next available day is highlighted.
    await expect(page.getByText("Next available")).toBeVisible();
    await pickFirstTime(page);
    await page.getByRole("button", { name: "Continue" }).click();

    // Review: sign up inline; the selection is untouched.
    await expect(page).toHaveURL(/\/book\/review/);
    await expect(page.getByRole("heading", { name: "Sign in to confirm" })).toBeVisible();
    const email = uniqueEmail("flow");
    await page.getByLabel("Full name").fill("Flow Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    // The address has to be confirmed first; the emailed link signs the person in and returns
    // to this very step, so nothing they picked is lost.
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await page.goto(pathOf(firstLink(await waitForMail(email, { subject: /confirm/i }))));
    await expect(page).toHaveURL(/\/book\/review/);
    await expect(page.getByRole("heading", { name: "Sign in to confirm" })).toHaveCount(0);
    await expect(page.getByRole("complementary", { name: "Your booking" })).toContainText(
      "Haircut",
    );

    await page.getByLabel("Notes for the salon (optional)").fill("Fragrance-free products, please");
    await page.getByRole("button", { name: "Confirm booking" }).click();

    // Success screen with details, calendar export and a way to manage it.
    await expect(page.getByRole("heading", { name: "You're booked!" })).toBeVisible();
    await expect(page.getByText("Haircut")).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Add to calendar" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^appointment-\d{4}-\d{2}-\d{2}\.ics$/);
    const stream = await file.createReadStream();
    let ics = "";
    for await (const chunk of stream) ics += chunk.toString();
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("SUMMARY:Sisters of Beauty: Haircut\\, Blow dry");

    await page.getByRole("link", { name: "Manage appointment" }).click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.getByText("Just booked")).toBeVisible();
  });

  test("steps are deep-linkable and back/forward keep the selection", async ({ page }) => {
    await startBooking(page);
    await pickProfessional(page, "Any available professional");
    await expect(page).toHaveURL(/staff=any/);
    await page.goBack();
    await expect(page).toHaveURL(/\/book\/professional/);
    await expect(page.getByRole("radio", { name: "Any available professional" })).toBeChecked();
    await page.goBack();
    await expect(page.getByRole("checkbox", { name: /Haircut/ })).toBeChecked();
    await page.goForward();
    await page.goForward();
    await expect(page).toHaveURL(/\/book\/time/);
    const url = page.url();
    await page.goto(url);
    await expect(page.getByRole("main").getByRole("group").first()).toBeVisible();
  });

  test("a step cannot be skipped: the URL falls back to the first incomplete step", async ({
    page,
  }) => {
    await page.goto("/book/review");
    await expect(page).toHaveURL(/\/book$/);
    await page.goto("/book/time?services=not-a-uuid");
    await expect(page).toHaveURL(/\/book$/);
  });

  test("the summary stays visible and no step scrolls horizontally", async ({ page }) => {
    await startBooking(page);
    await expect(page.getByRole("complementary", { name: "Your booking" })).toBeVisible();
    await pickProfessional(page, "Any available professional");
    await expect(page.getByRole("complementary", { name: "Your booking" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("a service that nobody performs together with another is explained", async ({ page }) => {
    await page.goto("/book");
    await page.getByRole("checkbox", { name: /Haircut/ }).check();
    await page.getByRole("checkbox", { name: /Manicure/ }).check();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("No one offers all of these services together")).toBeVisible();
    await page.getByRole("link", { name: "Back to services" }).click();
    await expect(page.getByRole("checkbox", { name: /Haircut/ })).toBeChecked();
  });

  test("touch targets on the booking flow are at least 44px", async ({ page }) => {
    await page.goto("/book");
    const small = await page.evaluate(() => {
      const offenders: string[] = [];
      const targets = document.querySelectorAll("button, a[href], label, select, summary");
      for (const el of targets) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (el.getAttribute("href")?.startsWith("#")) continue; // skip link: only visible on focus
        // Inline links inside running text are exempt (WCAG 2.5.8 inline exception).
        if (el.tagName === "A" && el.closest("p, li") && getComputedStyle(el).display === "inline")
          continue;
        if (rect.height < 43.5)
          offenders.push(
            `${el.tagName} ${(el.textContent ?? "").trim().slice(0, 30)} ${Math.round(rect.height)}px`,
          );
      }
      return offenders;
    });
    expect(small).toEqual([]);
  });
});

test.describe("slot races", () => {
  test("two people book the same slot: the second gets a friendly message and keeps their choices", async ({
    browser,
    request,
    baseURL,
  }) => {
    const origin = baseURL as string;
    const services = (await (await request.get("/api/services")).json()).services as {
      id: string;
      name: string;
    }[];
    const staff = (await (await request.get("/api/staff")).json()).staff as {
      id: string;
      displayName: string;
    }[];
    const haircut = services.find((s) => s.name === "Haircut");
    const stylist = staff.find((s) => s.displayName === "Stylist A");
    if (!haircut || !stylist) throw new Error("seed data missing");

    // Find the first offered slot with the real availability endpoint.
    let slot: { startsAt: string; date: string } | undefined;
    for (let day = 0; day < 14 && !slot; day++) {
      const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
      const result = await (
        await request.get(
          `/api/availability?serviceIds=${haircut.id}&staffId=${stylist.id}&date=${date}`,
        )
      ).json();
      const last = result.slots.at(-1);
      if (last) slot = { startsAt: last.startsAt, date };
    }
    if (!slot) throw new Error("no availability to race for");
    const review = `/book/review?services=${haircut.id}&staff=${stylist.id}&date=${slot.date}&slot=${encodeURIComponent(slot.startsAt)}&slotStaff=${stylist.id}`;

    const first = await browser.newContext({ baseURL: origin });
    const second = await browser.newContext({ baseURL: origin });
    const [a, b] = [await first.newPage(), await second.newPage()];
    await createClient(first.request, origin, { name: "Racer A" });
    await createClient(second.request, origin, { name: "Racer B" });
    // Sign-up already set the session cookie in each context.

    await Promise.all([a.goto(review), b.goto(review)]);
    await expect(a.getByRole("button", { name: "Confirm booking" })).toBeEnabled();
    await expect(b.getByRole("button", { name: "Confirm booking" })).toBeEnabled();

    await a.getByRole("button", { name: "Confirm booking" }).click();
    await expect(a.getByRole("heading", { name: "You're booked!" })).toBeVisible();

    await b.getByRole("button", { name: "Confirm booking" }).click();
    await expect(b).toHaveURL(/\/book\/time/);
    await expect(b.getByRole("alert")).toContainText("That time was just booked by someone else");
    // Everything but the slot is kept.
    await expect(b).toHaveURL(new RegExp(`services=${haircut.id}`));
    await expect(b).toHaveURL(new RegExp(`staff=${stylist.id}`));
    await expect(b.getByRole("complementary", { name: "Your booking" })).toContainText("Haircut");
    await expect(b.getByRole("complementary", { name: "Your booking" })).toContainText("Stylist A");
    await expect(b.getByRole("button", { name: "Continue" })).toBeDisabled();
    // The refreshed grid no longer offers the lost time.
    await expect(b.locator(`input[name="slot"][id="slot-${slot.startsAt}"]`)).toHaveCount(0);

    await first.close();
    await second.close();
  });
});
