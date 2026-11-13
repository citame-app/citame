import AxeBuilder from "@axe-core/playwright";
import { type APIRequestContext, expect, type Page } from "@playwright/test";

export const SERVICES = { haircut: "Haircut", blowDry: "Blow dry", manicure: "Manicure" } as const;

let counter = 0;
export function uniqueEmail(label = "user"): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}@example.com`;
}

export const PASSWORD = "correct horse battery staple";

/** Creates a client through the public sign-up endpoint and returns the cookies to adopt. */
export async function createClient(
  request: APIRequestContext,
  baseURL: string,
  options: { name?: string; email?: string } = {},
) {
  const email = options.email ?? uniqueEmail();
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { origin: new URL(baseURL).origin },
    data: { email, name: options.name ?? "E2E Client", password: PASSWORD },
  });
  expect(response.ok(), await response.text()).toBe(true);
  return { email, name: options.name ?? "E2E Client" };
}

/** Signs in through the UI so cookies, redirects and the session refresh are all exercised. */
export async function signInThroughUi(page: Page, email: string, redirect?: string) {
  await page.goto(redirect ? `/sign-in?redirect=${encodeURIComponent(redirect)}` : "/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
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
  const first = page.getByRole("main").getByRole("group").getByRole("radio").first();
  await expect(first).toBeVisible();
  const id = await first.getAttribute("id");
  const label = (await page.locator(`label[for="${id}"]`).innerText()).trim();
  await first.check();
  return label;
}
