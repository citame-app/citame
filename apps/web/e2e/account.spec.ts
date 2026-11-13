import { expect, test } from "@playwright/test";
import { createClient, expectNoSeriousA11yViolations, signedInContext } from "./helpers";

async function bookViaApi(page: import("@playwright/test").Page, dayOffsetStart = 1) {
  const services = (await (await page.request.get("/api/services")).json()).services as {
    id: string;
    name: string;
  }[];
  const staff = (await (await page.request.get("/api/staff")).json()).staff as {
    id: string;
    displayName: string;
  }[];
  const haircut = services.find((s) => s.name === "Haircut");
  const stylist = staff.find((s) => s.displayName === "Stylist A");
  if (!haircut || !stylist) throw new Error("seed data missing");
  for (let day = dayOffsetStart; day < dayOffsetStart + 14; day++) {
    const date = new Date(Date.now() + day * 86_400_000).toISOString().slice(0, 10);
    const result = await (
      await page.request.get(
        `/api/availability?serviceIds=${haircut.id}&staffId=${stylist.id}&date=${date}`,
      )
    ).json();
    const slot = result.slots[Math.min(2, result.slots.length - 1)];
    if (!slot) continue;
    const response = await page.request.post("/api/appointments", {
      headers: { origin: new URL(page.url()).origin },
      data: { staffId: stylist.id, serviceIds: [haircut.id], startsAt: slot.startsAt },
    });
    expect(response.status(), await response.text()).toBe(201);
    return (await response.json()) as { id: string; startsAt: string };
  }
  throw new Error("no availability");
}

test.describe("client account", () => {
  test("empty state, then reschedule and cancel an appointment with confirmation", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await signedInContext(page, client.email);
    await expect(page.getByText("No appointments yet")).toBeVisible();
    await expectNoSeriousA11yViolations(page, "account empty");

    const appointment = await bookViaApi(page);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Upcoming" })).toBeVisible();
    const card = page.getByRole("article").first();
    await expect(card).toContainText("Haircut");
    await expect(card).toContainText("Stylist A");

    // Reschedule reuses the slot picker.
    await card.getByRole("button", { name: "Reschedule" }).click();
    await expect(page).toHaveURL(new RegExp(`/account/appointments/${appointment.id}/reschedule`));
    await expect(page.getByText("Current time")).toBeVisible();
    await expect(page.getByRole("button", { name: "Confirm new time" })).toBeDisabled();
    const slots = page.getByRole("main").getByRole("group").getByRole("radio");
    await expect(slots.first()).toBeVisible();
    const target = slots.nth(1);
    const targetId = await target.getAttribute("id");
    await target.check();
    await page.getByRole("button", { name: "Confirm new time" }).click();
    await expect(page.getByText("Your appointment was moved")).toBeVisible();
    await expect(page).toHaveURL(/\/account/);

    // Cancel: asks first, updates immediately, confirms with a toast.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel this appointment?" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep appointment" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Yes, cancel it" }).click();
    await expect(page.getByText("Your appointment was cancelled")).toBeVisible();
    await expect(page.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
  });

  test("profile: validation, saving name and phone, and sign out", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await signedInContext(page, client.email);
    await page.getByRole("link", { name: "Profile" }).click();
    await page.getByLabel("Phone").fill("abc");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Enter a valid phone number")).toBeVisible();
    await page.getByLabel("Full name").fill("Renamed Client");
    await page.getByLabel("Phone").fill("+54 9 11 5555-0000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Full name")).toHaveValue("Renamed Client");
    await expect(page.getByLabel("Phone")).toHaveValue("+54 9 11 5555-0000");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/$/);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in\?redirect=/);
  });

  test("a failing request shows an error state with a working retry", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await signedInContext(page, client.email);
    await page.route("**/api/appointments?*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "internal_error", message: "boom" } }),
      }),
    );
    await page.reload();
    await expect(page.getByRole("alert")).toContainText("Something went wrong");
    await page.unroute("**/api/appointments?*");
    await page.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByText("No appointments yet")).toBeVisible();
  });
});
