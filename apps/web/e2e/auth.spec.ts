import { expect, test } from "@playwright/test";
import {
  createClient,
  expectNoSeriousA11yViolations,
  PASSWORD,
  signInThroughUi,
  uniqueEmail,
} from "./helpers";
import { firstLink, pathOf, waitForMail } from "./mail";

test.describe("authentication", () => {
  test("sign up asks to confirm the email; the emailed link signs in and lands on the account page", async ({
    page,
  }) => {
    const email = uniqueEmail("signup");
    await page.goto("/sign-up");
    await page.getByLabel("Full name").fill("New Person");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expect(page.getByText(email)).toBeVisible();

    const mail = await waitForMail(email, { subject: /confirm/i });
    await page.goto(pathOf(firstLink(mail)));
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByRole("heading", { level: 1, name: "My appointments" })).toBeVisible();
  });

  test("inline validation explains each problem and puts focus on the first one", async ({
    page,
  }) => {
    await page.goto("/sign-up");
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    await expect(page.getByText("Enter your name")).toBeVisible();
    await expect(page.getByText("Enter a valid email address")).toBeVisible();
    await expect(page.getByText("Use at least 8 characters")).toBeVisible();
    await expect(page.getByLabel("Full name")).toBeFocused();
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
  });

  test("wrong credentials give a clear error; an existing email is never revealed on sign-up", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(client.email);
    await page.getByLabel("Password", { exact: true }).fill("not the right password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("The email or password is incorrect.");

    await page.goto("/sign-up");
    await page.getByLabel("Full name").fill("Dup");
    await page.getByLabel("Email").fill(client.email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    // Same screen as a brand-new address: the page cannot be used to probe who has an account.
    await expect(page.getByRole("heading", { name: "Check your inbox" })).toBeVisible();
    await expect(page.getByText("An account with this email already exists.")).toHaveCount(0);
    // The real owner of the address is told, by email, that they already have an account.
    const notice = await waitForMail(client.email, { subject: /already/i });
    expect(firstLink(notice)).toContain("/reset-password");
  });

  test("the password can be revealed and hidden", async ({ page }) => {
    await page.goto("/sign-in");
    const password = page.getByLabel("Password", { exact: true });
    await password.fill("secret");
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "Show password" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "Hide password" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("rate limiting (429) is explained with the wait time", async ({ page }) => {
    await page.route("**/api/auth/sign-in/email", (route) =>
      route.fulfill({
        status: 429,
        headers: { "retry-after": "42", "content-type": "application/json" },
        body: JSON.stringify({ error: { code: "rate_limited", message: "Too many requests" } }),
      }),
    );
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill("someone@example.com");
    await page.getByLabel("Password", { exact: true }).fill("whatever1");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Too many attempts");
    await expect(page.getByRole("alert")).toContainText("42 seconds");
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
  });

  test("a protected page sends you to sign in and back afterwards", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await page.goto("/account/profile");
    await expect(page).toHaveURL(/\/sign-in\?redirect=%2Faccount%2Fprofile/);
    await signInThroughUi(page, client.email, "/account/profile");
    await expect(page).toHaveURL(/\/account\/profile$/);
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/account$/);
  });

  test("open redirects are ignored", async ({ page, request, baseURL }) => {
    const client = await createClient(request, baseURL as string);
    await signInThroughUi(page, client.email, "https://evil.example/phish");
    await expect(page).toHaveURL(/\/account$/);
  });

  test("a client cannot open the staff dashboard; the owner can", async ({
    page,
    request,
    baseURL,
  }) => {
    const client = await createClient(request, baseURL as string);
    await signInThroughUi(page, client.email);
    await expect(page).toHaveURL(/\/account$/);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/account$/);
    await page.getByRole("button", { name: "Sign out" }).click();

    const ownerEmail = process.env.E2E_OWNER_EMAIL;
    const ownerPassword = process.env.E2E_OWNER_PASSWORD;
    test.skip(!ownerEmail || !ownerPassword, "E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD not set");
    await page.goto("/sign-in?redirect=%2Fadmin");
    await page.getByLabel("Email").fill(ownerEmail as string);
    await page.getByLabel("Password", { exact: true }).fill(ownerPassword as string);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/admin\/calendar$/);
    await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "admin calendar");
  });
});
