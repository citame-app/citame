import { expect, test } from "@playwright/test";
import {
  asOwner,
  at,
  book,
  freeHour,
  OWNER_EMAIL,
  runDays,
  STYLIST_A,
  signInAs,
} from "./admin-helpers";

const stamp = Date.now().toString(36);
const future = runDays(8);
const past = runDays(1, -1);
const day = (k: number) => future[k] as string;
const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
const label = (h: number, m = 0) =>
  `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;

test.describe("calendar", () => {
  test("creates a walk-in appointment by clicking the calendar button flow", async ({ page }) => {
    const h = await freeHour(day(0));
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${day(0)}`);
    await page.getByRole("button", { name: "Add to calendar" }).click();
    await page.getByRole("button", { name: "New appointment", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await dialog.getByRole("radio", { name: "New client" }).check();
    await dialog.getByLabel("Full name").fill(`Walk In ${stamp}`);
    await dialog.getByLabel("Team member").selectOption({ label: "Stylist A" });
    await dialog.getByRole("checkbox", { name: /Haircut/ }).check();
    await dialog.getByLabel("Start time").fill(hh(h));
    await dialog.getByRole("button", { name: "Create appointment" }).click();
    await expect(page.getByText("Appointment created")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: new RegExp(`${label(h)}.* Walk In ${stamp} Haircut Booked`),
      }),
    ).toBeVisible();
  });

  test("clicking an empty slot opens the form prefilled", async ({ page, isMobile }) => {
    test.skip(isMobile, "pointer placement is verified on desktop");
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${day(1)}`);
    const column = page.getByRole("group", { name: /Schedule for Stylist B/ });
    await column.getByTestId("slot-surface").click({ position: { x: 40, y: 3 * 60 * 1.6 + 5 } }); // 08:00 + 3h
    const dialog = page.getByRole("dialog", { name: "New appointment" });
    await expect(dialog.getByLabel("Team member")).toHaveValue(STYLIST_B_ID);
    await expect(dialog.getByLabel("Start time")).toHaveValue("11:00");
  });

  test("marks an appointment completed and another as no-show", async ({ page }) => {
    const date = past[0] as string;
    const owner = await asOwner();
    const h = await freeHour(date, 3);
    await book(owner, { date, time: hh(h), client: `Past One ${stamp}` });
    await book(owner, { date, time: hh(h + 2), client: `Past Two ${stamp}` });
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
    await page.getByRole("button", { name: new RegExp(`Past One ${stamp}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark completed" }).click();
    await expect(page.getByText("Marked as completed")).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`Past One ${stamp} Haircut.*Completed`) }),
    ).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`Past Two ${stamp}`) }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Mark no-show" }).click();
    await expect(page.getByText("Marked as no-show")).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`Past Two ${stamp} Haircut.*No-show`) }),
    ).toBeVisible();
  });

  test("a future appointment cannot be completed yet and says why", async ({ page }) => {
    const date = day(2);
    await book(await asOwner(), {
      date,
      time: hh(await freeHour(date)),
      client: `Future ${stamp}`,
    });
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
    await page.getByRole("button", { name: new RegExp(`Future ${stamp}`) }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("Outcomes can be recorded once the appointment starts."),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Mark completed" })).toHaveCount(0);
  });

  test("reschedules by dragging the block", async ({ page, isMobile }) => {
    test.skip(isMobile, "dragging is a desktop interaction; mobile uses the slot picker");
    const date = day(3);
    const h = await freeHour(date, 2);
    await book(await asOwner(), { date, time: hh(h), client: `Drag ${stamp}` });
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
    const block = page.getByRole("button", { name: new RegExp(`${label(h)}.* Drag ${stamp}`) });
    const box = (await block.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 10 + 40, { steps: 5 });
    await page.mouse.move(box.x + box.width / 2, box.y + 10 + 96, { steps: 10 });
    await page.mouse.up();
    await expect(page.getByText("Appointment moved")).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`${label(h + 1)}.* Drag ${stamp}`) }),
    ).toBeVisible();
  });

  test("reschedules with the keyboard (Alt+Arrow) and with the slot picker", async ({ page }) => {
    const date = day(4);
    const h = await freeHour(date, 2);
    await book(await asOwner(), { date, time: hh(h), client: `Keys ${stamp}` });
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
    const block = page.getByRole("button", { name: new RegExp(`${label(h)}.* Keys ${stamp}`) });
    await block.focus();
    await page.keyboard.press("Alt+ArrowDown");
    await expect(page.getByText("Appointment moved")).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`${label(h, 15)}.* Keys ${stamp}`) }),
    ).toBeVisible();

    // The same move through the drawer's slot picker (the alternative that also serves phones).
    await page.getByRole("button", { name: new RegExp(`Keys ${stamp}`) }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Reschedule" }).click();
    await dialog
      .getByRole("group", { name: /Morning|Afternoon|Evening/ })
      .getByRole("radio")
      .first()
      .check();
    await dialog.getByRole("button", { name: /^Move to / }).click();
    await expect(page.getByText("Appointment moved").last()).toBeVisible();
  });

  test("a move onto a taken time rolls back and shows the conflict with a way out", async ({
    page,
  }) => {
    const date = day(5);
    const owner = await asOwner();
    const h = await freeHour(date, 2);
    await book(owner, { date, time: hh(h), client: `Mover ${stamp}` });
    await book(owner, { date, time: hh(h + 1), client: `Blocker ${stamp}` });
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${date}`);
    const block = page.getByRole("button", { name: new RegExp(`${label(h)}.* Mover ${stamp}`) });
    await block.focus();
    await page.keyboard.press("Alt+ArrowDown");
    const banner = page.getByRole("alert").filter({ hasText: "Someone just took that time" });
    await expect(banner).toBeVisible();
    await expect(
      page.getByRole("button", { name: new RegExp(`${label(h)}.* Mover ${stamp}`) }),
    ).toBeVisible();
    await banner.getByRole("button", { name: "Open appointment" }).click();
    await expect(page.getByRole("dialog", { name: `Mover ${stamp}` })).toBeVisible();
  });

  test("the keyboard shortcuts help lists the shortcuts and navigation works", async ({ page }) => {
    await signInAs(page, OWNER_EMAIL, `/admin/calendar?date=${day(6)}`);
    await page.getByRole("heading", { level: 1, name: "Calendar" }).waitFor();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[role='dialog']")).toHaveCount(0);
    await page.keyboard.press("w");
    await expect(page).toHaveURL(/view=week/);
    await page.keyboard.press("d");
    await expect(page).toHaveURL(/view=day/);
  });
});

// keep the unused helpers referenced for tooling that tree-shakes imports
void at;
void STYLIST_A;
const STYLIST_B_ID = "0198f5a0-7b1c-7000-8000-000000000202";
