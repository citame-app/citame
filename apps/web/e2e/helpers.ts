import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { firstLink, pathOf, waitForMail } from "./mail";

export const SERVICES = { haircut: "Haircut", blowDry: "Blow dry", manicure: "Manicure" } as const;

let counter = 0;
export function uniqueEmail(label = "user"): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}@example.com`;
}

export const PASSWORD = "correct horse battery staple";

/**
 * Creates a client through the public sign-up endpoint and confirms the address the way a person
 * would: by opening the emailed link. Verification signs the request context in, so callers
 * that need a session (parallel booking contexts) have one; UI flows sign in again as usual.
 */
export async function createClient(
  request: APIRequestContext,
  baseURL: string,
  options: { name?: string; email?: string } = {},
) {
  const email = options.email ?? uniqueEmail();
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { origin: new URL(baseURL).origin },
    data: {
      email,
      name: options.name ?? "E2E Client",
      password: PASSWORD,
      callbackURL: "/verify-email?next=%2Faccount",
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const mail = await waitForMail(email, { subject: /confirm/i });
  const verified = await request.get(pathOf(firstLink(mail)), {
    headers: { origin: new URL(baseURL).origin },
  });
  expect(verified.ok(), await verified.text()).toBe(true);
  return { email, name: options.name ?? "E2E Client" };
}

/** Signs in through the UI so cookies, redirects and the session refresh are all exercised. */
export async function signInThroughUi(
  page: Page,
  email: string,
  redirect?: string,
  password = PASSWORD,
) {
  await page.goto(redirect ? `/sign-in?redirect=${encodeURIComponent(redirect)}` : "/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

/** Adopts the session of a freshly created client in this page's browser context. */
export async function signedInContext(page: Page, email: string) {
  await signInThroughUi(page, email);
  await expect(page).toHaveURL(/\/account$/);
}

/** Fails on serious or critical accessibility violations and prints what they are. */
export async function expectNoSeriousA11yViolations(page: Page, context = "") {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
  const summary = blocking.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(" "))
        .join("\n  ")}`,
  );
  if (blocking.length)
    console.error(
      "Accessibility details",
      JSON.stringify(
        blocking.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
        })),
      ),
    );
  expect(summary, `axe violations ${context}`.trim()).toEqual([]);
}

/** Opens the booking flow with a service preselected and walks to the time step. */
export async function startBooking(page: Page, service: string = SERVICES.haircut) {
  await page.goto("/book");
  await page.getByRole("checkbox", { name: new RegExp(service) }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/book\/professional/);
}

export async function pickProfessional(page: Page, name: string | RegExp) {
  await page.getByRole("radio", { name }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/book\/time/);
}

/** Picks the first offered time on the next available day. Returns its label. */
export async function pickFirstTime(page: Page): Promise<string> {
  const first = page.getByRole("main").locator('input[type="radio"][name="slot"]').first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute("id");
  const label = (await page.locator(`label[for="${id}"]`).textContent())?.trim() ?? "";
  await first.check();
  return label;
}

/** Admin preferences live in the account popover; public pages keep the language control visible. */
export async function switchLocale(page: Page, label: "Español" | "English") {
  const radio = page.getByRole("radio", { name: label, exact: true });
  const inMenu = !(await radio.isVisible());
  if (inMenu)
    await page
      .getByRole("button", { name: /^(Account and preferences|Cuenta y preferencias)$/ })
      .click();
  await radio.check();
  if (inMenu) await page.keyboard.press("Escape");
}
