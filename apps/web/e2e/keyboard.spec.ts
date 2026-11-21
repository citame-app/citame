import { expect, type Locator, type Page, test } from "@playwright/test";
import { createClient } from "./helpers";

/** Presses Tab until `target` has focus: the way a keyboard user finds it. */
async function tabTo(page: Page, target: Locator, max = 80) {
  for (let i = 0; i < max; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error(`could not reach ${target} with Tab`);
}

test("the whole booking flow can be completed with the keyboard alone", async ({
  page,
  request,
  baseURL,
}) => {
  const client = await createClient(request, baseURL as string);
  await page.goto("/book");

  // Services: reach the checkbox, toggle with Space.
  const haircut = page.getByRole("checkbox", { name: /Haircut/ });
  await tabTo(page, haircut);
  await page.keyboard.press("Space");
  await expect(haircut).toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  // Professional: radios are chosen with the arrow keys.
  await expect(page).toHaveURL(/\/book\/professional/);
  const any = page.getByRole("radio", { name: "Any available professional" });
  await tabTo(page, any);
  await page.keyboard.press("Space");
  await expect(any).toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  // Time: the first time slot is reachable and selectable.
  await expect(page).toHaveURL(/\/book\/time/);
  const firstSlot = page.getByRole("region", { name: "Choose a time" }).getByRole("radio").first();
  await expect(firstSlot).toBeVisible();
  await tabTo(page, firstSlot);
  await page.keyboard.press("Space");
  await expect(firstSlot).toBeChecked();
  await tabTo(page, page.getByRole("button", { name: "Continue" }));
  await page.keyboard.press("Enter");

  // Review: sign in inline using only the keyboard.
  await expect(page).toHaveURL(/\/book\/review/);
  const existing = page.getByRole("tab", { name: "I have an account" });
  await tabTo(page, existing);
  await page.keyboard.press("Enter");
  const email = page.getByLabel("Email");
  await tabTo(page, email);
  await page.keyboard.type(client.email);
  await page.keyboard.press("Tab");
  await page.keyboard.type("correct horse battery staple");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Confirm booking" })).toBeVisible();
  await tabTo(page, page.getByRole("button", { name: "Confirm booking" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "You're booked!" })).toBeVisible();
});

test("the skip link is the first tab stop and jumps to the content", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main")).toBeFocused();
});

test("focus is always visible", async ({ page }) => {
  await page.goto("/book");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const outline = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe("none");
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});
