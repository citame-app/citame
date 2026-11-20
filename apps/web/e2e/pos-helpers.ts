import { expect, type Page } from "@playwright/test";

export async function addCustomItem(page: Page, description: string, amount: string) {
  await page.getByRole("button", { name: "Custom amount", exact: true }).click();
  await page.getByLabel("Item or service", { exact: true }).fill(description);
  await page.getByLabel("Amount (EUR)", { exact: true }).fill(amount);
  await page.getByRole("button", { name: "Add to receipt", exact: true }).click();
}

export async function addCatalogProduct(page: Page, name: string, search: string) {
  await page.getByRole("button", { name: "Products", exact: true }).click();
  await page.getByLabel("Search items or scan a barcode", { exact: true }).fill(search);
  await page
    .getByRole("button")
    .filter({ has: page.getByText(name, { exact: true }) })
    .click();
}

export async function reviewReceipt(page: Page) {
  await page.getByRole("button", { name: "Select payment method", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Receipt", exact: true })).toBeVisible();
}

export async function closeReceipt(page: Page) {
  await page
    .getByRole("dialog", { name: "Receipt", exact: true })
    .getByRole("button", { name: "Close panel", exact: true })
    .click();
}
