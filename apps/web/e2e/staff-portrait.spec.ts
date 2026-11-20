import { expect, test } from "@playwright/test";
import { clientPhotoFixture } from "../../api/test/client-photo-fixture";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { signInThroughUi } from "./helpers";

test("a staff portrait stays private until published and removal can be cancelled", async ({
  page,
  request,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, "/admin/staff");
  await expect(page).toHaveURL((url) => url.pathname === "/admin/staff");
  const list = await page.request.get("/api/admin/staff");
  expect(list.ok()).toBe(true);
  const { staff } = await list.json();
  const member = staff.find(
    (candidate: { active: boolean; portraitVersion?: string }) =>
      candidate.active && !candidate.portraitVersion,
  );
  expect(member).toBeDefined();
  await page.goto(`/admin/staff?member=${member.id}`);
  await page.getByLabel("Profile photo", { exact: true }).setInputFiles({
    name: "synthetic.jpg",
    mimeType: "image/jpeg",
    buffer: await clientPhotoFixture(),
  });
  await page.getByRole("button", { name: "Save photo", exact: true }).click();
  const publish = page.getByRole("button", {
    name: "Show photo on the booking site",
    exact: true,
  });
  await expect(publish).toBeVisible();
  const portrait = page.locator(`img[src^="/api/admin/staff/${member.id}/portrait"]`);
  await expect
    .poll(() => portrait.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const privateUrl = await portrait.getAttribute("src");
  const version = new URL(privateUrl ?? "", fixture.baseURL).searchParams.get("v");
  expect(version).toBeTruthy();
  expect((await request.get(`/api/staff/${member.id}/portrait/${version}`)).status()).toBe(404);

  await publish.click();
  await expect(
    page.getByRole("button", { name: "Hide photo from the booking site" }),
  ).toBeVisible();
  const publishedSrc = await portrait.getAttribute("src");
  const publishedVersion = new URL(publishedSrc ?? "", fixture.baseURL).searchParams.get("v");
  expect(publishedVersion).toBeTruthy();
  expect(publishedVersion).not.toBe(version);
  const publicUrl = `/api/staff/${member.id}/portrait/${publishedVersion}`;
  expect((await request.get(publicUrl)).status()).toBe(200);
  const remove = page.getByRole("button", {
    name: "Remove photo",
    exact: true,
  });
  const confirmation = page.getByRole("dialog", {
    name: "Remove photo",
    exact: true,
  });
  await remove.click();
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  expect((await request.get(publicUrl)).status()).toBe(200);

  await remove.click();
  await confirmation.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(portrait).toHaveCount(0);
  expect((await request.get(publicUrl)).status()).toBe(404);
});

test("an upload draft cannot revive a portrait another session added and removed", async ({
  browser,
  page,
}) => {
  await signInThroughUi(page, fixture.ownerEmail, "/admin/staff");
  await expect(page).toHaveURL((url) => url.pathname === "/admin/staff");
  const list = await page.request.get("/api/admin/staff");
  expect(list.ok()).toBe(true);
  const { staff } = await list.json();
  const member = staff.find(
    (candidate: { active: boolean; portraitVersion?: string }) =>
      candidate.active && !candidate.portraitVersion,
  );
  expect(member).toBeDefined();

  const secondSession = await browser.newContext({ baseURL: fixture.baseURL });
  try {
    const other = await secondSession.newPage();
    await signInThroughUi(other, fixture.ownerEmail, "/admin/staff");
    await expect(other).toHaveURL((url) => url.pathname === "/admin/staff");
    await page.goto(`/admin/staff?member=${member.id}`);
    const input = page.getByLabel("Profile photo", { exact: true });
    const buffer = await clientPhotoFixture();
    await input.setInputFiles({ name: "draft.jpg", mimeType: "image/jpeg", buffer });
    const path = `/api/admin/staff/${member.id}/portrait`;
    const originalVersion = member.portraitAbsenceVersion ?? null;
    const created = await other.request.put(path, {
      data: { version: originalVersion, imageBase64: buffer.toString("base64") },
    });
    expect(created.ok()).toBe(true);
    const { version } = await created.json();
    const portrait = page.locator(`img[src="${path}?v=${version}"]`);
    await expect(portrait).toBeVisible();
    const removed = await other.request.put(path, { data: { version, imageBase64: null } });
    expect(removed.ok()).toBe(true);
    await expect(portrait).toHaveCount(0);

    const stale = page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === "PUT",
    );
    await page.getByRole("button", { name: "Save photo", exact: true }).click();
    const refused = await stale;
    expect(refused.status()).toBe(409);
    expect(refused.request().postDataJSON().version).toBe(originalVersion);
    await expect(
      page.getByText("The photo changed in another session. Review it and try again."),
    ).toBeVisible();

    const reselected = page.waitForResponse(
      (response) => response.url().endsWith(path) && response.request().method() === "PUT",
    );
    await input.setInputFiles({ name: "reviewed.jpg", mimeType: "image/jpeg", buffer });
    await page.getByRole("button", { name: "Save photo", exact: true }).click();
    const saved = await reselected;
    expect(saved.ok()).toBe(true);
    const reviewedVersion = saved.request().postDataJSON().version;
    expect(reviewedVersion).toBeTruthy();
    expect(reviewedVersion).not.toBe(originalVersion);
  } finally {
    await secondSession.close();
  }
});
