import { expect, test } from "@playwright/test";
import { asOwner } from "./admin-helpers";
import {
  createClient,
  expectNoSeriousA11yViolations,
  PASSWORD,
  signInThroughUi,
  uniqueEmail,
} from "./helpers";
import { firstLink, pathOf, waitForMail } from "./mail";

test.describe("password reset", () => {
  test("forgot password, emailed link, new password, old one stops working", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(page).toHaveURL(/\/forgot-password$/);
    await expectNoSeriousA11yViolations(page, "forgot password");

    await page.getByLabel("Email").fill(client.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();

    const mail = await waitForMail(client.email, { subject: /reset/i });
    await page.goto(pathOf(firstLink(mail)));
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await expect(page.getByRole("heading", { level: 1, name: "Choose a new password" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "reset password");

    const next = "a brand new passphrase 42";
    await page.getByLabel("New password", { exact: true }).fill(next);
    await page.getByLabel("Repeat the new password").fill("something different");
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByText("The two passwords do not match.")).toBeVisible();
    await page.getByLabel("Repeat the new password").fill(next);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByRole("heading", { name: "Password saved" })).toBeVisible();

    // The old password is dead, the new one works.
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(client.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The email or password is incorrect.");
    await page.getByLabel("Password", { exact: true }).fill(next);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);

    // The link is single-use.
    await page.goto(pathOf(firstLink(mail)));
    await expect(page.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible();
  });

  test("an unknown address gets the same confirmation and no email", async ({ page }) => {
    const ghost = uniqueEmail("ghost");
    await page.goto("/forgot-password");
    await page.getByLabel("Email").fill(ghost);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expect(page.getByText(`If an account exists for ${ghost}`)).toBeVisible();
    await expect(waitForMail(ghost, { timeoutMs: 1500 })).rejects.toThrow(/No mail/);
  });

  test("an invalid link says so and offers a way forward, in Spanish too", async ({
    page,
    context,
  }) => {
    await page.goto("/reset-password?error=INVALID_TOKEN");
    await expect(page.getByRole("heading", { name: "This link is no longer valid" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "invalid reset link");
    await context.addCookies([{ name: "sob_locale", value: "es-AR", url: page.url() }]);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Este enlace ya no es válido" })).toBeVisible();
    await page.getByRole("link", { name: "Pedir un enlace nuevo" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Restablecé tu contraseña" })).toBeVisible();
  });
});

test.describe("email verification", () => {
  test("signing in before confirming sends a fresh link and explains what to do", async ({
    page,
  }) => {
    const email = uniqueEmail("unconfirmed");
    await page.goto("/sign-up");
    await page.getByLabel("Full name").fill("Not Yet");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "check your inbox");

    await signInThroughUi(page, email);
    await expect(page.getByRole("alert")).toContainText("not confirmed yet");
    await expect(page).toHaveURL(/\/sign-in/);

    const mail = await waitForMail(email, { subject: /confirm/i });
    await page.goto(pathOf(firstLink(mail)));
    await expect(page).toHaveURL(/\/account$/);
  });

  test("an expired confirmation link lets the person ask for a new one", async ({ page }) => {
    await page.goto("/verify-email?error=invalid_token&next=%2Faccount");
    await expect(
      page.getByRole("heading", { name: "This confirmation link is no longer valid" }),
    ).toBeVisible();
    await expectNoSeriousA11yViolations(page, "invalid confirmation link");
  });
});

test.describe("staff invitation", () => {
  test("the owner invites a team member, who chooses their own password and reaches the dashboard", async ({
    page,
    browser,
  }) => {
    const owner = await asOwner();
    const email = uniqueEmail("invitee");
    const created = await owner.post("/api/admin/staff-accounts", {
      data: { email, name: "Invited Stylist" },
    });
    expect(created.status(), await created.text()).toBe(201);
    expect(((await created.json()) as { invited: boolean }).invited).toBe(true);

    const mail = await waitForMail(email, { subject: /invited/i });
    await page.goto(pathOf(firstLink(mail)));
    await expect(page).toHaveURL(/\/reset-password\?invited=1&token=/);
    await expect(page.getByRole("heading", { level: 1, name: "Set your password" })).toBeVisible();
    const password = "my own team passphrase";
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Repeat the new password").fill(password);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page.getByRole("heading", { name: "Password saved" })).toBeVisible();

    const fresh = await browser.newContext();
    const staffPage = await fresh.newPage();
    await staffPage.goto("/sign-in");
    await staffPage.getByLabel("Email").fill(email);
    await staffPage.getByLabel("Password", { exact: true }).fill(password);
    await staffPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(staffPage).toHaveURL(/\/admin/);
    await fresh.close();
    await owner.dispose();
  });
});
