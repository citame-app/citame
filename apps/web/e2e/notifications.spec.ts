import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient, expectNoSeriousA11yViolations, signedInContext } from "./helpers";

/** Mirrors apps/api/src/notifications/tokens.ts; needs the API's BETTER_AUTH_SECRET. */
function optOutToken(secret: string, clientId: string): string {
  const key = `sob.notifications.v1:${secret}`;
  const body = Buffer.from(JSON.stringify({ c: clientId, ch: "email" })).toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

test.describe("notification preferences and opt-out", () => {
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });

      test("a client edits preferences, accessibly", async ({ page, request, baseURL }) => {
        const client = await createClient(request, baseURL as string);
        await signedInContext(page, client.email);
        await page.goto("/account/notifications");
        await expect(page.getByRole("heading", { name: "Notifications", level: 2 })).toBeVisible();
        const email = page.getByRole("group", { name: "Email" });
        const reminders = email.getByLabel("Reminders before your appointment");
        await expect(reminders).toBeChecked();
        await expectNoSeriousA11yViolations(page, `notifications (${scheme})`);

        await reminders.uncheck();
        await page.getByRole("button", { name: "Save preferences" }).click();
        await expect(page.getByText("Preferences saved")).toBeVisible();
        await page.reload();
        await expect(
          page
            .getByRole("group", { name: "Email" })
            .getByLabel("Reminders before your appointment"),
        ).not.toBeChecked();
        // Without a phone number SMS cannot be switched on.
        await expect(
          page.getByRole("group", { name: "Text messages (SMS)" }).getByRole("checkbox").first(),
        ).toBeDisabled();
      });

      test("the opt-out page rejects a bad link", async ({ page }) => {
        await page.goto("/notifications/opt-out?token=not-a-real-token");
        await expect(page.getByRole("heading", { name: "This link is not valid" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `opt-out invalid (${scheme})`);
      });

      test("a valid opt-out link needs a click and then switches reminders off", async ({
        page,
        request,
        baseURL,
      }) => {
        const secret = process.env.E2E_AUTH_SECRET;
        test.skip(!secret, "set E2E_AUTH_SECRET to the API's BETTER_AUTH_SECRET");
        const client = await createClient(request, baseURL as string);
        await signedInContext(page, client.email);
        const me = await (await page.request.get("/api/me")).json();
        const token = optOutToken(secret as string, me.clientId);
        await page.context().clearCookies();
        await page.goto(`/notifications/opt-out?token=${encodeURIComponent(token)}`);
        await expect(
          page.getByRole("heading", { name: "Stop appointment reminders" }),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(page, `opt-out (${scheme})`);
        await page.getByRole("button", { name: "Stop reminders" }).click();
        await expect(page.getByRole("heading", { name: "Reminders turned off" })).toBeVisible();
        await expectNoSeriousA11yViolations(page, `opt-out done (${scheme})`);
      });
    });
  }
});
