import { expect, test } from "@playwright/test";
import { inventoryNumberingSnapshotSchema } from "@sob/contracts";
import { browserTarget } from "../test/browser-target";
import { signInThroughUi } from "./helpers";

test("the owner can review a changed document series without retyping the proposed number", async ({
  page,
}) => {
  const path = "/api/admin/settings/inventory-numbering";
  await signInThroughUi(
    page,
    browserTarget.ownerEmail,
    "/admin/settings?section=numbering",
    browserTarget.password,
  );
  const orders = page.getByRole("form", { name: "Purchase orders" });
  const nextNumber = orders.getByLabel("New next number");
  const save = orders.getByRole("button", { name: "Advance numbering" });
  const review = orders.getByRole("button", { name: "Review current numbering" });
  await expect(nextNumber).toBeVisible();
  const snapshot = inventoryNumberingSnapshotSchema.parse(
    await (await page.request.get(path)).json(),
  );
  const current = snapshot.orders.nextNumber;
  if (current === null) throw new Error("Missing next purchase order number");
  const candidate = current + 10;
  await nextNumber.fill("-1");
  await save.click();
  await expect(nextNumber).toBeFocused();
  await expect(nextNumber).toHaveAttribute("aria-invalid", "true");
  await nextNumber.fill(String(candidate));
  const concurrent = await page.request.put(`${path}/orders`, {
    headers: { Origin: browserTarget.baseURL },
    data: {
      generation: snapshot.generation,
      expectedNextNumber: current,
      nextNumber: current + 1,
    },
  });
  expect(concurrent.status(), await concurrent.text()).toBe(200);
  await expect(review).toBeVisible();
  await expect(save).toBeDisabled();
  await review.click();
  await expect(nextNumber).toHaveValue(String(candidate));
  await expect(save).toBeEnabled();
  await save.click();
  await expect(orders.getByText(String(candidate), { exact: true })).toBeVisible();
  await expect(nextNumber).toHaveValue("");
});
