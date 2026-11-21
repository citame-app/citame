import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  asOwner,
  at,
  BLOW_DRY,
  book,
  ensureStaff,
  expectNoHorizontalScroll,
  HAIRCUT,
  OWNER_EMAIL,
  runDays,
  STYLIST_A,
  salonDate,
  setStatus,
  signInAs,
  TZ,
  weekdayOf,
} from "./admin-helpers";
import { createClient, PASSWORD, switchLocale } from "./helpers";

const stamp = Date.now().toString(36);
const STAFF_EMAIL = "e2e-staff@example.com";

test.describe("clients", () => {
  test("search, sort and page the directory server-side", async ({ page, request, baseURL }) => {
    test.setTimeout(120_000);
    const names = Array.from(
      { length: 22 },
      (_, i) => `Pg${stamp} ${String.fromCharCode(97 + (i % 26))}${i}`,
    );
    for (const name of names) await createClient(request, baseURL as string, { name });
    await signInAs(page, OWNER_EMAIL, `/admin/clients?q=Pg${stamp}`);
    const grid = page.getByRole("table", { name: "Clients" });
    const list = page.getByRole("list", { name: "Clients" });
    await expect(page.getByText("Showing 1-20 of 22")).toBeVisible();
    const isDesktop = await grid.isVisible();
    const rows = isDesktop ? grid.getByRole("row") : list.getByRole("listitem");
    expect(await rows.count()).toBe(isDesktop ? 21 : 20);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.getByText(`Showing 21-22 of 22`)).toBeVisible();
    // sort: names are "Pg.. a0", "b1", ... so descending puts the last letter first
    if (isDesktop) {
      await page.getByRole("button", { name: "Sort by Name" }).click();
      await expect(page).toHaveURL(/order=desc/);
      await expect(page).toHaveURL(/page=1/);
    }
    await page.getByLabel("Search clients").fill(`Pg${stamp} b1`);
    await expect(page.getByText("Showing 1-1 of 1")).toBeVisible();
    await page
      .getByRole("button", { name: `Pg${stamp} b1` })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 2, name: `Pg${stamp} b1` })).toBeVisible();
  });

  test("edit notes and phone from the client page", async ({ page, request, baseURL }) => {
    const client = await createClient(request, baseURL as string, { name: `Notes ${stamp}` });
    await signInAs(page, OWNER_EMAIL, `/admin/clients?q=${encodeURIComponent(client.name)}`);
    await page.getByRole("button", { name: client.name }).first().click();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await page.getByLabel("Phone").fill("+54 9 11 5555-1234");
    await page.getByLabel("Private notes").fill("Prefers the window chair");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Client updated")).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "Profile", exact: true }).click();
    await expect(page.getByLabel("Private notes")).toHaveValue("Prefers the window chair");
  });
});

test.describe("services", () => {
  test("create, edit and deactivate a service and see it in the booking flow", async ({ page }) => {
    const name = `Service ${stamp}`;
    await signInAs(page, OWNER_EMAIL, "/admin/services");
    await page.getByRole("button", { name: "New service" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New service" });
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(dialog.getByText("Enter a whole number greater than zero")).toBeVisible();
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByLabel("Duration (minutes)").fill("30");
    await dialog.getByLabel("Price", { exact: true }).fill("12000");
    await dialog.getByRole("button", { name: "How clients see it", exact: true }).click();
    await expect(
      dialog.getByRole("region", { name: "How clients see it" }).getByText(name),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Employees", exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Stylist A" }).check();
    await dialog.getByRole("button", { name: "Create" }).click();
    await expect(page.getByText("Service created")).toBeVisible();

    await page.goto("/book");
    await expect(page.getByRole("checkbox", { name: new RegExp(name) })).toBeVisible();

    await page.goto("/admin/services");
    await page.getByRole("button", { name }).first().click();
    const edit = page.getByRole("dialog", { name: "Edit service" });
    await edit.getByLabel("Price", { exact: true }).fill("13000");
    await edit.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Service saved")).toBeVisible();
    await expect(
      page
        .getByText(/13,000|13\.000/)
        .filter({ visible: true })
        .first(),
    ).toBeVisible();

    const row = page
      .getByRole("table", { name: "Services" })
      .getByRole("row", { name: new RegExp(name) });
    const card = page
      .getByRole("list", { name: "Services" })
      .getByRole("listitem")
      .filter({ hasText: name });
    const scope = (await row.count()) > 0 && (await row.isVisible()) ? row : card;
    await scope.getByRole("button", { name: "Deactivate" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    await expect(page.getByText("Service deactivated")).toBeVisible();
    await page.goto("/book");
    await expect(page.getByRole("checkbox", { name: new RegExp(name) })).toHaveCount(0);
  });
});

test.describe("team", () => {
  test("editing hours warns about the existing appointments that no longer fit", async ({
    page,
  }) => {
    const email = `hours-${stamp}@example.com`;
    const { staffId } = await ensureStaff(email, `Hours ${stamp}`);
    const date = runDays(1)[0] as string;
    const owner = await asOwner();
    await book(owner, { staffId, date, time: "10:00", client: `Fits ${stamp}` });
    const weekday = weekdayOf(date);
    await signInAs(page, OWNER_EMAIL, `/admin/staff?member=${staffId}&tab=hours`);
    const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
      weekday
    ] as string;
    const group = page.getByRole("group", { name: dayName });
    await group.getByLabel(new RegExp(`From \\(${dayName}, range 1\\)`)).fill("12:00");
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await page.getByRole("button", { name: "Save hours" }).click();
    await expect(page.getByText("Working hours saved")).toBeVisible();
    const warning = page.getByRole("region", { name: /existing appointment no longer fits/ });
    await expect(warning).toBeVisible();
    await expect(warning.getByText(/outside working hours/)).toBeVisible();
    await expect(warning.getByRole("link", { name: /Fits/ })).toBeVisible();
  });

  test("staff manage their own time off but cannot change their hours", async ({ page }) => {
    await ensureStaff(STAFF_EMAIL, "E2E Stylist");
    const [date] = runDays(1, 1, [1, 2, 3, 4, 5]);
    await signInAs(page, STAFF_EMAIL, "/admin/staff");
    await expect(page.getByText("Only the owner can change working hours.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save hours" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Time off" }).click();
    await page.getByRole("button", { name: "Add time off" }).click();
    const dialog = page.getByRole("dialog", { name: "Add time off" });
    await dialog.getByLabel("Start date").fill(date as string);
    await dialog.getByLabel("End date").fill(date as string);
    await dialog.getByLabel("Reason (optional)").fill(`Dentist ${stamp}`);
    await dialog.getByRole("button", { name: "Save time off" }).click();
    await expect(page.getByText("Time off saved")).toBeVisible();
    const list = page.getByRole("list", { name: "Time off" });
    await expect(list.getByText(`Dentist ${stamp}`)).toBeVisible();
    await page.getByRole("button", { name: `Edit time off: Dentist ${stamp}` }).click();
    await page.getByRole("dialog").getByLabel("Reason (optional)").fill(`Dentist 2 ${stamp}`);
    await page.getByRole("dialog").getByRole("button", { name: "Save time off" }).click();
    await expect(list.getByText(`Dentist 2 ${stamp}`)).toBeVisible();
    await page.getByRole("button", { name: `Remove time off: Dentist 2 ${stamp}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Time off removed")).toBeVisible();
    await expect(list.getByText(`Dentist 2 ${stamp}`)).toHaveCount(0);
  });

  test("deactivating a team member with future appointments is blocked until they are resolved", async ({
    page,
  }) => {
    const name = `Leaver ${stamp}`;
    const { staffId } = await ensureStaff(`leaver-${stamp}@example.com`, name);
    const [date] = runDays(1);
    const owner = await asOwner();
    await book(owner, {
      staffId,
      date: date as string,
      time: "11:00",
      client: `Blocking ${stamp}`,
    });
    await signInAs(page, OWNER_EMAIL, "/admin/staff");
    await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
    const grid = page.getByRole("table", { name: "Team members" });
    const list = page.getByRole("list", { name: "Team members" });
    const scope = (await grid.isVisible())
      ? grid.getByRole("row", { name: new RegExp(name) })
      : list.getByRole("listitem").filter({ hasText: name });
    await scope.getByRole("button", { name: "Deactivate" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
    const panel = page.getByRole("dialog", { name: `${name} still has upcoming appointments` });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(`Blocking ${stamp}`)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Deactivate now" })).toBeDisabled();
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Cancel this appointment?" })
      .getByRole("button", { name: "Yes, cancel it" })
      .click();
    await expect(
      panel.getByText("No upcoming appointments are left. You can deactivate now."),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Deactivate now" }).click();
    await expect(page.getByText("Team member deactivated")).toBeVisible();
    const after = (await (await owner.get("/api/admin/staff")).json()) as {
      staff: { id: string; active: boolean }[];
    };
    expect(after.staff.find((s) => s.id === staffId)?.active).toBe(false);
  });
});

test.describe("reports", () => {
  // A fixed, long-past Tuesday: the fixture is created once and the numbers below are exact.
  const past = (() => {
    let offset = -200;
    while (weekdayOf(salonDate(offset)) !== 2) offset -= 1;
    return salonDate(offset);
  })();

  test.beforeAll(async () => {
    const owner = await asOwner();
    const a = await book(owner, {
      date: past,
      time: "10:00",
      client: "Report Fixture A",
      serviceIds: [HAIRCUT],
    });
    const b = await book(owner, {
      date: past,
      time: "12:00",
      client: "Report Fixture B",
      serviceIds: [HAIRCUT, BLOW_DRY],
    });
    const c = await book(owner, {
      date: past,
      time: "15:00",
      client: "Report Fixture C",
      serviceIds: [HAIRCUT],
    });
    if (a) await setStatus(owner, a.id, a.version, "completed");
    if (b) await setStatus(owner, b.id, b.version, "completed");
    if (c) await setStatus(owner, c.id, c.version, "no_show");
  });

  test("numbers match the seeded fixture, the table alternative agrees, and the CSV has the same data", async ({
    page,
  }) => {
    await signInAs(
      page,
      OWNER_EMAIL,
      `/admin/reports?preset=custom&from=${past}&to=${past}&staff=${STYLIST_A}`,
    );
    const tiles = page.getByRole("group", { name: "Summary" });
    await expect(tiles.getByText("Appointments").locator("xpath=following-sibling::dd")).toHaveText(
      "3",
    );
    await expect(tiles.getByText("Completed").locator("xpath=following-sibling::dd")).toHaveText(
      "2",
    );
    await expect(tiles.getByText("Revenue").locator("xpath=following-sibling::dd")).toHaveText(
      /40,000/,
    );
    await expect(tiles.getByText("No-show rate").locator("xpath=following-sibling::dd")).toHaveText(
      "33%",
    );

    const top = page.getByRole("table", { name: "Top services" });
    const topScope = (await top.isVisible())
      ? top
      : page.getByRole("list", { name: "Top services" });
    await expect(topScope).toContainText("Haircut");
    await expect(topScope).toContainText("30,000");
    await expect(topScope).toContainText("Blow dry");
    await expect(topScope).toContainText("10,000");

    const figure = page.getByRole("figure", { name: "Revenue per day" });
    await figure.getByRole("button", { name: "Show data table" }).click();
    await expect(figure.getByRole("table").getByRole("cell", { name: /40,000/ })).toBeVisible();

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await download;
    const path = await file.path();
    const csv = readFileSync(path as string, "utf8");
    expect(csv.split("\r\n")[0]).toBe(
      "date,appointments,booked,completed,cancelled,no_show,revenue,currency",
    );
    expect(csv).toContain(`${past},3,0,2,0,1,40000.00,ARS`);
    expect(csv).toContain("Haircut,2,30000.00,ARS");
    expect(csv).toContain("Blow dry,1,10000.00,ARS");
    expect(csv).toContain("Stylist A,3,2,1,0.3333,40000.00,ARS");
  });

  test("an empty period shows a clear empty state", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, "/admin/reports?preset=custom&from=2020-01-06&to=2020-01-07");
    await expect(page.getByText("No appointments in this period")).toBeVisible();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();
  });

  test("staff see only their own numbers and no team filter", async ({ page }) => {
    await signInAs(page, STAFF_EMAIL, `/admin/reports?preset=custom&from=${past}&to=${past}`);
    await expect(page.getByLabel("Team member")).toHaveCount(0);
    await expect(
      page
        .getByRole("group", { name: "Summary" })
        .getByText("Appointments")
        .locator("xpath=following-sibling::dd"),
    ).toHaveText("0");
  });
});

test.describe("settings", () => {
  test("a change is reflected in booking availability", async ({ page }) => {
    const date = runDays(1)[0] as string;
    const owner = await asOwner();
    const minutes = async () => {
      const res = await owner.get("/api/availability", {
        params: { serviceIds: HAIRCUT, staffId: STYLIST_A, date },
      });
      const body = (await res.json()) as { slots: { startsAt: string }[] };
      return new Set(body.slots.map((s) => new Date(s.startsAt).getUTCMinutes()));
    };
    await signInAs(page, OWNER_EMAIL, "/admin/settings?section=booking");
    await page.getByLabel("Time slot interval").selectOption("30");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved").first()).toBeVisible();
    expect([...(await minutes())].every((m) => m === 0 || m === 30)).toBe(true);
    await page.getByLabel("Time slot interval").selectOption("15");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(page.getByText("Settings saved").last()).toBeVisible();
    expect((await minutes()).size).toBeGreaterThan(2);
  });

  test("the salon name is editable and an unsaved form asks before leaving", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, "/admin/settings");
    await page.getByLabel("Salon name").fill(`Provisional salon name ${stamp}`);
    await page.getByRole("link", { name: "Clients" }).first().click();
    await expect(page.getByRole("dialog", { name: "Discard your changes?" })).toBeVisible();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(page).toHaveURL(/\/admin\/settings/);
  });
});

test.describe("preferences and layout", () => {
  test("the language switch translates the dashboard", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, "/admin/calendar");
    await switchLocale(page, "Español");
    await expect(page.getByRole("heading", { level: 1, name: "Agenda" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Añadir a la agenda" })).toBeVisible();
    await switchLocale(page, "English");
    await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
  });

  test("dark mode applies to the dashboard", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, "/admin");
    await page.getByRole("button", { name: "Account and preferences" }).click();
    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("no section scrolls the page sideways", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, "/admin");
    for (const path of [
      "/admin/calendar",
      "/admin/clients",
      "/admin/services",
      "/admin/staff",
      "/admin/reports",
      "/admin/settings",
    ]) {
      await page.goto(path);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForLoadState("networkidle");
      await expectNoHorizontalScroll(page);
    }
  });
});

void at;
void TZ;
void PASSWORD;
