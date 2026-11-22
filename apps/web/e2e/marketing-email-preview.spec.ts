import { expect, test } from "@playwright/test";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";
import { waitForMail } from "./mail";

test("a draft email test reaches the owner's inbox without activating the campaign", async ({
  page,
}) => {
  const email = process.env.E2E_OWNER_EMAIL;
  const password = process.env.E2E_OWNER_PASSWORD;
  if (!email || !password) {
    test.skip(true, "The isolated owner and SMTP sink are required");
    return;
  }

  const label = crypto.randomUUID();
  await signInThroughUi(page, email, "/admin/marketing", password);
  await page
    .getByRole("button", { name: "Campaigns and automations", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "New campaign", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "New campaign", exact: true });
  await editor.getByRole("button", { name: "Write your own message", exact: true }).click();
  await editor.getByLabel("Campaign name", { exact: true }).fill(`Test ${label}`);
  await editor.getByLabel("Email subject", { exact: true }).fill(`Preview ${label}`);
  await editor.getByLabel("Email message", { exact: true }).fill(`Hello {{first_name}}. ${label}`);
  await editor.getByRole("button", { name: "Review recipients", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review recipients", exact: true });
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url().endsWith("/test-email")),
    review.getByRole("button", { name: "Send test to my email", exact: true }).click(),
  ]);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: "accepted" });
  await expect(review.getByText("Test email accepted. Check your inbox.")).toBeVisible();
  const message = await waitForMail(email, { subject: new RegExp(`Preview ${label}`) });
  expect(message.subject).toBe(`[Prueba / Test] Preview ${label}`);
  expect(message.text).toContain(label);
  expect(message.html).not.toContain("/marketing/opt-out");
  const draft = await page.request.get(response.url().replace(/\/test-email$/, ""));
  expect(await draft.json()).toMatchObject({ status: "draft", counts: { pending: 0, sent: 0 } });
  await expectNoHorizontalScroll(page);
  await expectNoSeriousA11yViolations(page, "Marketing test email");
});
