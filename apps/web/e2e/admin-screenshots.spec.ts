import { expect, type Page, test } from "@playwright/test";
import {
  asOwner,
  at,
  book,
  ensureStaff,
  freeHour,
  OWNER_EMAIL,
  runDays,
  STYLIST_A,
  STYLIST_B,
  salonDate,
  setStatus,
  signInAs,
  weekdayOf,
} from "./admin-helpers";
import { createClient } from "./helpers";

const MANICURE = "0198f5a0-7b1c-7000-8000-000000000104";

/** Not assertions: a visual record of every admin screen and state, reviewed by a human. */
test.describe("admin screenshots", () => {
  let index = 0;
  const shoot = async (page: Page, project: string, name: string, full = true) => {
    index += 1;
    await page.waitForTimeout(350);
    await page.screenshot({
      path: `e2e/screenshots/admin/${project}/${String(index).padStart(2, "0")}-${name}.png`,
      fullPage: full,
      animations: "disabled",
    });
  };

  test("capture", async ({ page: realPage, browser, request, baseURL }, testInfo) => {
    let page = realPage;
    test.setTimeout(240_000);
    const project = testInfo.project.name;
    const mobile = project === "mobile";
    const stamp = Date.now().toString(36);
    const owner = await asOwner();
    await ensureStaff("e2e-staff@example.com", "E2E Stylist");

    // A fixed, long-past Tuesday with a believable day: the "today" of the screenshots.
    let off = -200;
    while (weekdayOf(salonDate(off)) !== 2) off -= 1;
    const day = salonDate(off);
    const a = await book(owner, {
      date: day,
      time: "10:00",
      client: "Report Fixture A",
      serviceIds: ["0198f5a0-7b1c-7000-8000-000000000101"],
    });
    const b = await book(owner, {
      date: day,
      time: "12:00",
      client: "Report Fixture B",
      serviceIds: ["0198f5a0-7b1c-7000-8000-000000000101", "0198f5a0-7b1c-7000-8000-000000000102"],
    });
    const c = await book(owner, {
      date: day,
      time: "15:00",
      client: "Report Fixture C",
      serviceIds: ["0198f5a0-7b1c-7000-8000-000000000101"],
    });
    for (const [x, status] of [
      [a, "completed"],
      [b, "completed"],
      [c, "no_show"],
    ] as const) {
      if (x) await setStatus(owner, x.id, x.version, status);
    }
    await book(owner, {
      staffId: STYLIST_B,
      serviceIds: [MANICURE],
      date: day,
      time: "13:00",
      client: "Shot Pending Lucia",
    });
    await book(owner, {
      staffId: STYLIST_B,
      serviceIds: [MANICURE],
      date: day,
      time: "16:30",
      client: "Shot Next Romina",
    });
    await book(owner, {
      staffId: STYLIST_B,
      serviceIds: [MANICURE],
      date: day,
      time: "10:30",
      client: "Shot Cancelled Nora",
    }).then(async (x) => {
      if (x)
        await owner.patch(`/api/appointments/${x.id}`, {
          data: { version: x.version, status: "cancelled" },
        });
    });
    await owner.post(`/api/admin/staff/${STYLIST_B}/time-off`, {
      data: { startsAt: at(day, "17:30"), endsAt: at(day, "18:00"), reason: "Early finish" },
    });

    // Future data for the conflict and blocked screens.
    let future = "";
    let fh = 0;
    for (const candidate of runDays(12)) {
      try {
        fh = await freeHour(candidate, 2);
        future = candidate;
        break;
      } catch {
        // that day is full, try the next one
      }
    }
    expect(future, "a future day with a free block").not.toBe("");
    await book(owner, {
      date: future as string,
      time: `${String(fh).padStart(2, "0")}:00`,
      client: `Shot Mover ${stamp}`,
    });
    await book(owner, {
      date: future as string,
      time: `${String(fh + 1).padStart(2, "0")}:00`,
      client: `Shot Blocker ${stamp}`,
    });
    const leaver = await ensureStaff(`shot-leaver-${stamp}@example.com`, `Shot Leaver ${stamp}`);
    await book(owner, {
      staffId: leaver.staffId,
      date: future as string,
      time: "15:00",
      client: `Shot Leaver Client ${stamp}`,
    });
    const hoursStaff = await ensureStaff(`shot-hours-${stamp}@example.com`, `Shot Hours ${stamp}`);
    await book(owner, {
      staffId: hoursStaff.staffId,
      date: future as string,
      time: "10:00",
      client: `Shot Hours Client ${stamp}`,
    });
    for (let i = 0; i < 6; i++)
      await createClient(request, baseURL as string, { name: `Shot Client ${stamp} ${i}` });

    const fixedAt = new Date(at(day, "14:00"));
    /** A second browser context whose clock is pinned to 14:00 on the fixture day. */
    const pinnedPage = async (colorScheme: "light" | "dark" = "light") => {
      const context = await browser.newContext({
        ...testInfo.project.use,
        baseURL,
        locale: "en",
        colorScheme,
        timezoneId: "America/Argentina/Buenos_Aires",
      });
      await context.clock.setFixedTime(fixedAt);
      const p = await context.newPage();
      await signInAs(p, OWNER_EMAIL, "/admin");
      return p;
    };
    const dayUrl = `/admin/calendar?date=${day}&staff=${STYLIST_A},${STYLIST_B}`;

    // ---- empty "today" (a weekend in real time) and forbidden notice ----
    await signInAs(page, OWNER_EMAIL, "/admin");
    await expect(page.getByRole("heading", { level: 1, name: "Today" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "today-real-day");

    // ---- today with data: the browser clock is pinned to 14:00 on the fixture day ----
    page = await pinnedPage();
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Waiting for an outcome" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "today-with-data");

    await page.goto(dayUrl);
    await expect(page.getByRole("button", { name: /Report Fixture A/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "calendar-day");

    await page.goto(`/admin/calendar?view=week&date=${day}&staff=${STYLIST_A}`);
    await expect(page.getByRole("button", { name: /Report Fixture A/ })).toBeVisible();
    await shoot(page, project, "calendar-week");

    await page.goto(dayUrl);
    await page.getByRole("button", { name: /Shot Pending Lucia/ }).click();
    await expect(page.getByRole("dialog", { name: "Shot Pending Lucia" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "calendar-drawer", false);
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await dialog.getByRole("radio", { name: "New client" }).check();
    await dialog.getByLabel("Team member").selectOption({ label: "Stylist A" });
    await dialog.getByRole("checkbox", { name: /Haircut/ }).check();
    await dialog.getByRole("button", { name: "Create appointment" }).click();
    await shoot(page, project, "calendar-new-appointment-errors", false);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await shoot(page, project, "calendar-shortcuts", false);
    await page.keyboard.press("Escape");
    await page.getByRole("checkbox", { name: "Show cancelled" }).check();
    await shoot(page, project, "calendar-with-cancelled");
    await page.getByRole("button", { name: "Team members" }).click();
    await shoot(page, project, "calendar-staff-filter", false);
    await page.keyboard.press("Escape");

    // conflict banner on a real future day: a fresh page, so its clock is the real one
    page = realPage;
    await page.goto(`/admin/calendar?date=${future}&staff=${STYLIST_A}`);
    const mover = page.getByRole("button", { name: new RegExp(`Shot Mover ${stamp}`) });
    await expect(mover).toBeVisible();
    await mover.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(
      page.getByRole("alert").filter({ hasText: "Someone just took that time" }),
    ).toBeVisible();
    await shoot(page, project, "calendar-conflict-banner");
    await page
      .getByRole("alert")
      .filter({ hasText: "Someone just took that time" })
      .getByRole("button", { name: "Open appointment" })
      .click();
    await page.getByRole("dialog").getByRole("button", { name: "Reschedule" }).click();
    await page
      .getByRole("dialog")
      .getByRole("group", { name: /Morning|Afternoon|Evening/ })
      .first()
      .waitFor({ state: "attached", timeout: 15_000 });
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^Move to|Reschedule/ })
      .last()
      .scrollIntoViewIfNeeded();
    await shoot(page, project, "calendar-drawer-reschedule", false);
    await page.keyboard.press("Escape");

    // loading and error states (the API is delayed, then fails)
    await page.route("**/api/appointments/calendar**", async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue().catch(() => {});
    });
    await page.goto(`/admin/calendar?date=${day}`);
    await expect(page.getByRole("status", { name: "Loading" })).toBeVisible();
    await shoot(page, project, "calendar-loading", false);
    await page.unroute("**/api/appointments/calendar**");
    await page.route("**/api/appointments/calendar**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal_error", message: "boom" } }),
      }),
    );
    await page.goto(`/admin/calendar?date=${day}`);
    await expect(page.getByRole("alert").first()).toBeVisible({ timeout: 15_000 });
    await shoot(page, project, "calendar-error", false);
    await page.unroute("**/api/appointments/calendar**");

    // ---- clients ----
    await page.goto(`/admin/clients?q=Shot Client ${stamp}`);
    await expect(page.getByText(/Showing 1-6 of 6/)).toBeVisible();
    await shoot(page, project, "clients-list");
    await page.goto("/admin/clients?q=zzzzzz-nothing");
    await expect(page.getByText(/No clients match/)).toBeVisible();
    await shoot(page, project, "clients-no-match", false);
    await page.goto(`/admin/clients?q=Shot Client ${stamp} 0`);
    await page
      .getByRole("button", { name: `Shot Client ${stamp} 0` })
      .filter({ visible: true })
      .first()
      .click();
    await expect(page.getByLabel("Private notes")).toBeVisible();
    await page.getByLabel("Private notes").fill("Prefers the window chair. Allergic to latex.");
    await shoot(page, project, "client-detail-unsaved");
    await page.getByRole("button", { name: "Delete client" }).click();
    await shoot(page, project, "client-delete-confirm", false);
    await page.keyboard.press("Escape");

    // ---- services ----
    await page.goto("/admin/services");
    await expect(
      page
        .getByRole("table", { name: "Services" })
        .or(page.getByRole("list", { name: "Services" }))
        .first(),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "services-list");
    await page.getByRole("button", { name: "New service" }).first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Create" }).click();
    await shoot(page, project, "services-create-errors", false);
    await page.getByRole("dialog").getByLabel("Name").fill("Gel manicure");
    await page.getByRole("dialog").getByLabel("Duration (minutes)").fill("75");
    await page.getByRole("dialog").getByLabel("Price").fill("12000");
    await page
      .getByRole("dialog")
      .getByLabel("Description (optional)")
      .fill("Long-lasting gel polish with nail prep.");
    await shoot(page, project, "services-preview", false);
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Discard your changes?" })
      .getByRole("button", { name: "Discard and leave" })
      .click();

    // ---- team ----
    await page.goto("/admin/staff");
    await expect(
      page.getByText(`Shot Leaver ${stamp}`).filter({ visible: true }).first(),
    ).toBeVisible();
    await shoot(page, project, "team-list");
    await page.getByRole("button", { name: "New team member" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Create account" }).click();
    await shoot(page, project, "team-create-errors", false);
    await page.keyboard.press("Escape");
    const row = page
      .getByRole("table", { name: "Team members" })
      .getByRole("row", { name: new RegExp(`Shot Leaver ${stamp}`) })
      .or(
        page
          .getByRole("list", { name: "Team members" })
          .getByRole("listitem")
          .filter({ hasText: `Shot Leaver ${stamp}` }),
      )
      .first();
    await row.getByRole("button", { name: "Deactivate" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(
      page.getByRole("dialog", { name: /still has upcoming appointments/ }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "team-blocked-deactivation", false);
    await page.keyboard.press("Escape");

    await page.goto(`/admin/staff?member=${hoursStaff.staffId}&tab=hours`);
    const dow = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      weekdayOf(future as string)
    ] as string;
    await page
      .getByRole("group", { name: dow })
      .getByLabel(new RegExp(`From \\(${dow}, range 1\\)`))
      .fill("12:00");
    await shoot(page, project, "team-hours-unsaved");
    await page.getByRole("button", { name: "Save hours" }).click();
    await expect(page.getByRole("region", { name: /no longer fit/ })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "team-hours-conflicts");
    await page.goto(`/admin/staff?member=${hoursStaff.staffId}&tab=timeoff`);
    await expect(page.getByText("No time off scheduled")).toBeVisible();
    await shoot(page, project, "team-timeoff-empty", false);
    await page.goto(`/admin/staff?member=${STYLIST_B}&tab=timeoff`);
    await expect(page.getByText("Early finish").first()).toBeVisible();
    await shoot(page, project, "team-timeoff-list", false);

    // ---- reports ----
    await page.goto(
      `/admin/reports?preset=custom&from=${salonDate(off - 6)}&to=${day}&staff=${STYLIST_A}`,
    );
    await expect(page.getByRole("group", { name: "Summary" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(600);
    await shoot(page, project, "reports-charts");
    await page.getByRole("button", { name: "Show data table" }).first().click();
    await shoot(page, project, "reports-table-alternative");
    await page.goto("/admin/reports?preset=custom&from=2020-01-06&to=2020-01-07");
    await expect(page.getByText("No appointments in this period")).toBeVisible();
    await shoot(page, project, "reports-empty", false);
    await page.goto("/admin/reports?preset=custom&from=2026-03-10&to=2026-03-01");
    await shoot(page, project, "reports-invalid-range", false);

    // ---- settings ----
    await page.goto("/admin/settings");
    await expect(page.getByLabel("Salon name")).toBeVisible();
    await shoot(page, project, "settings");
    await page.getByLabel("Minimum notice (minutes)").fill("90");
    await page
      .getByRole("link", { name: "Clients" })
      .first()
      .click({ trial: false })
      .catch(() => {});
    await expect(page.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
    await shoot(page, project, "settings-unsaved-guard", false);
    await page.getByRole("button", { name: "Keep editing" }).click();

    // ---- mobile navigation ----
    if (mobile) {
      await page.goto("/admin");
      await page
        .getByRole("navigation", { name: "Dashboard sections (mobile)" })
        .getByRole("button", { name: "More" })
        .click();
      await shoot(page, project, "mobile-more-menu", false);
      await page.keyboard.press("Escape");
    }

    // ---- dark mode and Spanish ----
    page = await pinnedPage("dark");
    for (const [path, name] of [
      ["/admin", "dark-today"],
      [dayUrl, "dark-calendar-day"],
      [
        `/admin/reports?preset=custom&from=${salonDate(off - 6)}&to=${day}&staff=${STYLIST_A}`,
        "dark-reports",
      ],
      ["/admin/services", "dark-services"],
      ["/admin/clients", "dark-clients"],
      ["/admin/staff", "dark-team"],
      ["/admin/settings", "dark-settings"],
    ] as const) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await shoot(page, project, name);
    }
    page = await pinnedPage("light");
    await page.goto(dayUrl);
    await page.getByLabel("Español").check({ force: true });
    await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "es-calendar-day");
    await page.goto("/admin");
    await shoot(page, project, "es-today");
    await page.goto("/admin/staff");
    await shoot(page, project, "es-team");
    for (const [path, name] of [
      ["/admin/clients", "es-clients"],
      ["/admin/services", "es-services"],
      [
        `/admin/reports?preset=custom&from=${salonDate(off - 6)}&to=${day}&staff=${STYLIST_A}`,
        "es-reports",
      ],
      ["/admin/settings", "es-settings"],
    ] as const) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      await shoot(page, project, name);
    }
    await page.goto(dayUrl);
    await page.getByRole("button", { name: /Shot Pending Lucia/ }).click();
    await page.waitForLoadState("networkidle");
    await shoot(page, project, "es-calendar-drawer", false);
    await page.keyboard.press("Escape");

    // ---- staff role: own schedule and the forbidden notice ----
    await page.goto("/admin");
    await page.getByLabel("English").check({ force: true });
    await page.context().clearCookies();
    await signInAs(page, "e2e-staff@example.com", "/admin/services");
    await expect(
      page.getByRole("alert").filter({ hasText: "You do not have access" }),
    ).toBeVisible();
    await shoot(page, project, "staff-forbidden-notice", false);
    await page.getByLabel("Español").check({ force: true });
    await page.goto("/admin/services");
    await expect(page.getByRole("alert").filter({ hasText: "No tienes acceso" })).toBeVisible();
    await shoot(page, project, "es-staff-forbidden-notice", false);
  });
});
