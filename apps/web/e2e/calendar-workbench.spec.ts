import { expect, type Page, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

const path = "/admin/calendar?date=2026-11-17";
async function selectCalendarView(page: Page, value: "day" | "week" | "month" | "list") {
  const select = page.getByRole("combobox", { name: "Calendar view" });
  if (await select.isVisible()) await select.selectOption(value);
  else
    await page
      .getByRole("group", { name: "Calendar view", exact: true })
      .getByRole("button", {
        name: ({ day: "Day", week: "Week", month: "Month", list: "List" } as const)[value],
        exact: true,
      })
      .click();
}
const staffId = "0198f5a0-7b1c-7000-8000-000000000201";

test("waitlist stays in the calendar; blocks and full-day absences persist with salon-local dates", async ({
  page,
  baseURL,
}, info) => {
  const date = info.project.name === "desktop" ? "2026-11-30" : "2026-12-01";
  const headers = { origin: baseURL ?? "http://localhost:4273" };
  await signInThroughUi(page, fixture.ownerEmail, `/admin/calendar?date=${date}`);
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  const policyResponse = await page.request.get("/api/admin/waitlist");
  expect(policyResponse.ok()).toBeTruthy();
  const { policy } = await policyResponse.json();
  if (!policy.enabled)
    expect(
      (
        await page.request.put("/api/admin/waitlist/policy", {
          headers,
          data: { ...policy, enabled: true },
        })
      ).ok(),
    ).toBeTruthy();
  const customers = await page.request.get(
    "/api/admin/clients?search=Cliente%20de%20demostraci%C3%B3n",
  );
  const { clients } = await customers.json();
  const joined = await page.request.post("/api/admin/waitlist", {
    headers,
    data: {
      clientId: clients[0].id,
      serviceIds: [fixture.haircut],
      staffId,
      fromDate: date,
      toDate: date,
      fromTime: "10:00",
      toTime: "12:00",
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(joined.status(), await joined.text()).toBe(201);
  const entry = await joined.json();
  await page.reload();
  await page.getByRole("button", { name: "View waitlist (1)", exact: true }).click();
  const waitlist = page.getByRole("dialog", { name: "Waitlist", exact: true });
  await expect(waitlist).toContainText("Cliente de demostración");
  await waitlist.getByRole("button", { name: /Cliente de demostración/ }).click();
  await expect(waitlist.getByRole("button", { name: "Cancel waitlist request" })).toBeVisible();
  await expectNoSeriousA11yViolations(page);
  await expect(page).toHaveURL(new RegExp(`date=${date}`));
  if (info.project.name === "desktop")
    await page.screenshot({ path: "../../.taste-skill/calendar/waitlist.png" });
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: "Add to calendar" }).click();
  await page.getByRole("button", { name: "Block time", exact: true }).click();
  const block = page.getByRole("dialog", { name: "Block time", exact: true });
  await expect(block.getByLabel("Start date")).toHaveValue(date);
  const reason = `Bloqueo de prueba ${info.project.name}`;
  await block.getByLabel("Reason (optional)").fill(reason);
  await block.getByRole("button", { name: "Save time off" }).click();
  await expect(block).toHaveCount(0);
  const saved = await page.request.get(`/api/admin/staff/${staffId}/time-off`);
  const body = await saved.json();
  const timed = body.timeOff.find((value: { reason: string }) => value.reason === reason);
  expect(timed.startsAt).toBe(`${date}T08:00:00.000Z`);
  expect(timed.endsAt).toBe(`${date}T08:30:00.000Z`);
  await page.getByRole("button", { name: "Add to calendar" }).click();
  await page.getByRole("button", { name: "Add absence", exact: true }).click();
  const absence = page.getByRole("dialog", { name: "Add absence", exact: true });
  await expect(absence.getByLabel("All day", { exact: true })).toBeChecked();
  await expect(absence.getByLabel("Start time")).toHaveCount(0);
  await absence.getByLabel("Reason (optional)").fill(`Ausencia ${reason}`);
  if (info.project.name === "desktop")
    await page.screenshot({ path: "../../.taste-skill/calendar/absence.png" });
  await absence.getByRole("button", { name: "Save time off" }).click();
  await expect(absence).toHaveCount(0);
  const all = await (await page.request.get(`/api/admin/staff/${staffId}/time-off`)).json();
  const fullDay = all.timeOff.find(
    (value: { reason: string }) => value.reason === `Ausencia ${reason}`,
  );
  const midnight = new Date(`${date}T00:00:00+01:00`);
  expect(fullDay.startsAt).toBe(midnight.toISOString());
  expect(fullDay.endsAt).toBe(new Date(midnight.getTime() + 86400000).toISOString());
  for (const id of [timed.id, fullDay.id])
    expect(
      (await page.request.delete(`/api/admin/staff/${staffId}/time-off/${id}`, { headers })).ok(),
    ).toBeTruthy();
  expect(
    (
      await page.request.post(`/api/admin/waitlist/${entry.id}/cancel`, {
        headers,
        data: { version: entry.version },
      })
    ).ok(),
  ).toBeTruthy();
});

test("notifications retain history after reload and archive independently of the toast", async ({
  page,
  baseURL,
}, info) => {
  await signInThroughUi(page, fixture.ownerEmail, path);
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  const name = `Historial ${info.project.name}`;
  const created = await page.request.post("/api/appointments", {
    headers: { origin: baseURL ?? "http://localhost:4273" },
    data: {
      staffId,
      serviceIds: [fixture.haircut],
      startsAt: info.project.name === "desktop" ? "2026-12-02T08:30:00Z" : "2026-12-02T12:30:00Z",
      client: { name },
      override: true,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.reload();
  await page.getByRole("button", { name: /^Notifications(?: \d+\+?)?$/ }).click();
  let panel = page.getByRole("dialog", { name: /^Notifications(?: \d+\+?)?$/ });
  let row = panel.getByRole("listitem").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expectNoSeriousA11yViolations(page);
  if (info.project.name === "desktop")
    await page.screenshot({ path: "../../.taste-skill/calendar/inbox.png" });
  await row.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: /^Notifications(?: \d+\+?)?$/ }).click();
  panel = page.getByRole("dialog", { name: /^Notifications(?: \d+\+?)?$/ });
  await expect(panel.getByRole("listitem").filter({ hasText: name })).toHaveCount(0);
  await panel.getByRole("button", { name: "Archived", exact: true }).click();
  row = panel.getByRole("listitem").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await row.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(row).toHaveCount(0);
  await panel.getByRole("button", { name: "Active", exact: true }).click();
  await panel.getByRole("listitem").filter({ hasText: name }).getByRole("link").click();
  await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
  await expect(page).toHaveURL(/date=2026-12-02/);
});

test("four calendar views, local filters and reservation details across screen sizes", async ({
  page,
}, info) => {
  test.setTimeout(120000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signInThroughUi(page, fixture.ownerEmail, path);
  await expect(page.getByRole("img", { name: "Live updates connected" })).toBeVisible();
  await expect(page.locator(".calendar-card")).toHaveCount(42);
  const widths = info.project.name === "mobile" ? [320, 390] : [1024, 1440, 1920];
  for (const width of widths) {
    await page.setViewportSize({ width, height: width < 768 ? 844 : 920 });
    await expectNoHorizontalScroll(page);
    await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add to calendar" })).toBeVisible();
  }
  await page.getByRole("searchbox", { name: "Search appointments" }).fill("Cejas con hilo");
  await expect(page.locator(".calendar-card")).toHaveCount(7);
  await page.getByRole("searchbox", { name: "Search appointments" }).fill("");
  const screenshotDir = "../../.taste-skill/calendar";
  const timings: Record<string, number> = {};
  if (info.project.name === "desktop") await page.screenshot({ path: `${screenshotDir}/day.png` });
  for (const view of ["week", "month", "list"] as const) {
    const started = Date.now();
    await selectCalendarView(page, view);
    await expect(page).toHaveURL(new RegExp(`view=${view}`));
    await expect(
      page.locator(view === "list" ? ".calendar-agenda" : ".calendar-overview"),
    ).toBeVisible();
    await expect(
      page.getByRole("region", {
        name: view === "week" ? "Week" : view === "month" ? "Month" : "List",
        exact: true,
      }),
    ).toBeVisible();
    timings[view] = Date.now() - started;
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, `calendar ${view}`);
    if (info.project.name === "desktop")
      await page.screenshot({ path: `${screenshotDir}/${view}.png` });
  }
  await info.attach("calendar-view-latency", {
    body: JSON.stringify({
      screen: info.project.name,
      fixtures: { staff: 6, appointmentsPerDay: 42, appointmentsPerWeek: 210 },
      milliseconds: timings,
    }),
    contentType: "application/json",
  });
  console.info(`Calendar ${info.project.name} view latency ms: ${JSON.stringify(timings)}`);
  await selectCalendarView(page, "day");
  await page.locator(".calendar-card").first().click();
  await expect(page.getByRole("dialog", { name: "Cliente de demostración" })).toBeVisible();
  await page.getByRole("button", { name: "Close panel" }).click();
  await page.getByRole("button", { name: /Choose date/ }).click();
  const datePicker = page.getByRole("dialog", { name: /Choose date/ });
  // The native calendar popup has a labelled date field as a keyboard alternative.
  await page.getByLabel("Go to date").fill("2026-11-18");
  await expect(page).toHaveURL(/date=2026-11-18/);
  await expect(page.locator(".calendar-card")).toHaveCount(42);
  await expectNoSeriousA11yViolations(page, "calendar day");
  await page.emulateMedia({ colorScheme: "dark" });
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, "calendar dark");
  if (info.project.name === "desktop") await page.screenshot({ path: `${screenshotDir}/dark.png` });
  expect(errors).toEqual([]);
  void datePicker;
});

test("SSE announces a remote booking, opens its date and recovers after a disconnection", async ({
  page,
  browser,
  baseURL,
}, info) => {
  test.setTimeout(90000);
  await signInThroughUi(page, fixture.ownerEmail, path);
  await expect(page.getByRole("img", { name: "Live updates connected" })).toBeVisible();
  const remote = await browser.newContext({ baseURL });
  try {
    const other = await remote.newPage();
    await signInThroughUi(other, fixture.ownerEmail, "/admin/calendar?date=2026-11-24");
    await expect(other.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
    const name = `Nueva cita SSE ${info.project.name}`;
    const startsAt =
      info.project.name === "desktop" ? "2026-11-24T08:30:00Z" : "2026-11-24T12:30:00Z";
    const response = await remote.request.post("/api/appointments", {
      headers: { origin: baseURL ?? "http://localhost:4273" },
      data: { staffId, serviceIds: [fixture.haircut], startsAt, client: { name }, override: true },
    });
    expect(response.status(), await response.text()).toBe(201);
    const appointment = await response.json();
    const committed = Date.now();
    const toast = page.getByRole("region", { name: "You have a new appointment!" });
    await expect(toast).toContainText(name);
    await expect(toast).toHaveCount(1);
    await info.attach("calendar-sse-latency", {
      body: JSON.stringify({
        screen: info.project.name,
        afterCreateResponseMs: Date.now() - committed,
      }),
      contentType: "application/json",
    });
    console.info(
      `Calendar ${info.project.name} SSE after create response ms: ${Date.now() - committed}`,
    );
    if (info.project.name === "desktop")
      await page.screenshot({ path: "../../.taste-skill/calendar/realtime-toast.png" });
    await toast.getByRole("link", { name: /View appointment/ }).click();
    await expect(page).toHaveURL(/date=2026-11-24/);
    await expect(page.getByRole("dialog", { name })).toBeVisible();
    await page.getByRole("button", { name: "Close panel" }).click();
    const moved = new Date(Date.parse(startsAt) + 3600000).toISOString();
    const patch = await remote.request.patch(`/api/appointments/${appointment.id}`, {
      headers: { origin: baseURL ?? "http://localhost:4273" },
      data: { startsAt: moved, version: appointment.version, override: true },
    });
    expect(patch.status(), await patch.text()).toBe(200);
    await expect(page.getByRole("region", { name: "Appointment rescheduled" })).toContainText(name);
    await page
      .getByRole("region", { name: "Appointment rescheduled" })
      .getByRole("button", { name: "Dismiss" })
      .click();
    await page.context().setOffline(true);
    await expect(page.getByRole("img", { name: "Reconnecting live updates" })).toBeVisible();
    const offline = await remote.request.post("/api/appointments", {
      headers: { origin: baseURL ?? "http://localhost:4273" },
      data: {
        staffId,
        serviceIds: [fixture.haircut],
        startsAt: info.project.name === "desktop" ? "2026-11-25T08:30:00Z" : "2026-11-25T12:30:00Z",
        client: { name: `Reconexión ${name}` },
        override: true,
      },
    });
    expect(offline.status(), await offline.text()).toBe(201);
    await page.context().setOffline(false);
    await expect(toast).toContainText(`Reconexión ${name}`, { timeout: 15000 });
    await expect(toast).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("img", { name: "Live updates connected" })).toBeVisible();
    await expect(toast).toHaveCount(0);
  } finally {
    await page.context().setOffline(false);
    await remote.close();
  }
});

test("SSE opens again after a terminal HTTP failure without a page reload", async ({ page }) => {
  test.setTimeout(60_000);
  const streamUrl = "**/api/sync/stream";
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sync/stream" && response.status() === 429,
  );
  await page.route(
    streamUrl,
    (route) => route.fulfill({ status: 429, headers: { "retry-after": "1" } }),
    { times: 1 },
  );
  await signInThroughUi(page, fixture.ownerEmail, path);
  await rejected;
  await expect(page.getByRole("img", { name: "Reconnecting live updates" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Live updates connected" })).toBeVisible({
    timeout: 40_000,
  });
});

test("drag and keyboard moves keep conflict rollback and read the committed server state", async ({
  page,
  isMobile,
  baseURL,
}, info) => {
  test.skip(isMobile, "touch rescheduling uses the existing slot picker");
  await signInThroughUi(page, fixture.ownerEmail, "/admin/calendar?date=2026-11-26");
  await expect(page.getByRole("heading", { name: "Calendar", exact: true })).toBeVisible();
  const make = async (name: string, staff: string, startsAt: string) => {
    const response = await page.request.post("/api/appointments", {
      headers: { origin: baseURL ?? "http://localhost:4273" },
      data: {
        staffId: staff,
        serviceIds: [fixture.haircut],
        startsAt,
        client: { name },
        override: true,
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  const visit = await make("Drag demo", staffId, "2026-11-26T09:00:00Z");
  await make("Occupied demo", "0198f5a0-7b1c-7000-8000-000000000202", "2026-11-26T10:00:00Z");
  const block = page.getByRole("button", { name: /Drag demo/ });
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  if (!box) throw new Error("Missing drag block");
  await page.mouse.move(box.x + 30, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 106, { steps: 15 });
  await page.mouse.up();
  await expect(page.getByText("Appointment moved", { exact: true }).last()).toBeVisible();
  await expect(block).toContainText("11:00 AM");
  await block.focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(
    page.getByRole("alert").filter({ hasText: "Someone just took that time" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: /Schedule for Profesional A/ })
      .getByRole("button", { name: /Drag demo/ }),
  ).toBeVisible();
  const response = await page.request.get(
    "/api/appointments/calendar?from=2026-11-25T23:00:00Z&to=2026-11-26T23:00:00Z",
  );
  const body = await response.json();
  expect(body.appointments.find((row: { id: string }) => row.id === visit.id)).toMatchObject({
    startsAt: "2026-11-26T10:00:00.000Z",
    staffId,
  });
  void info;
});

test("service badges preserve private notes, explicit professional preference and booking comments", async ({
  page,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, path);
  const card = page.getByRole("button", { name: /10:20.*11:20.*Invoiced in Booksy/ }).first();
  await expect(card.getByRole("img", { name: "Internal notes", exact: true })).toBeVisible();
  await card.click();
  const dialog = page.getByRole("dialog", { name: "Cliente de demostración", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Internal notes", exact: true })).toHaveValue(
    "Nota interna de demostración, solo para el equipo",
  );
  await expect(
    dialog.getByRole("checkbox", { name: "Client requested a specific professional" }),
  ).not.toBeChecked();
  const note = dialog.getByRole("textbox", { name: "Internal notes", exact: true });
  const save = dialog.getByRole("button", { name: "Save service details", exact: true });
  const original = await note.inputValue();
  await note.fill(`${original} · synthetic verification`);
  const firstSave = page.waitForResponse(
    (r) => r.url().endsWith("/context") && r.request().method() === "PATCH",
  );
  await save.click();
  expect((await firstSave).status()).toBe(200);
  await expect(save).toBeDisabled();
  await note.fill(original);
  const restored = page.waitForResponse(
    (r) => r.url().endsWith("/context") && r.request().method() === "PATCH",
  );
  await save.click();
  expect((await restored).status()).toBe(200);
  await expect(save).toBeDisabled();
  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalScroll(page);
  await dialog.getByRole("button", { name: "Close panel" }).click();
  const requested = page
    .getByRole("button", {
      name: /Paid in Booksy.*Client comment from booking.*Client requested a specific professional/,
    })
    .first();
  await requested.click();
  await expect(
    dialog.getByText("Comentario de reserva de demostración", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", { name: "Client requested a specific professional" }),
  ).toBeChecked();
  await expectNoSeriousA11yViolations(page);
  await expectNoHorizontalScroll(page);
});
