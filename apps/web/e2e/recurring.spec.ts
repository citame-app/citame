import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

/** Runs only with e2e:recurring: isolated DB/API and an intercepted hosted-bank destination. */
for (const scheme of ["light", "dark"] as const) {
  test.describe(`recurring memberships with simulated Redsys — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("consent, authenticated hosted capture, scheduled renewal and cancellation preserve paid benefits", async ({
      page,
    }) => {
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      try {
        const login = await owner.post("/api/auth/sign-in/email", {
          data: { email: fixture.ownerEmail, password: fixture.password },
        });
        expect(login.ok(), await login.text()).toBe(true);
        const name = `Monthly membership ${crypto.randomUUID()}`;
        const plan = await owner.post("/api/admin/benefit-plans", {
          data: {
            name,
            kind: "membership",
            priceCents: 1000,
            includedUses: 2,
            periodMonths: 1,
            serviceIds: [fixture.haircut],
            idempotencyKey: crypto.randomUUID(),
          },
        });
        expect(plan.status(), await plan.text()).toBe(201);
        let intercepted = 0;
        await page.route("https://sis-t.redsys.es:25443/**", async (route) => {
          intercepted++;
          expect(route.request().method()).toBe("POST");
          const fields = Object.fromEntries(new URLSearchParams(route.request().postData() ?? ""));
          const response = await page.request.post("/api/__recurring-fixture/settle", {
            headers: { "x-recurring-fixture": "local-only" },
            data: fields,
          });
          expect(response.status(), await response.text()).toBe(200);
          const { order } = await response.json();
          await route.fulfill({
            status: 302,
            headers: { location: `${fixture.baseURL}/payments/${order}` },
            body: "",
          });
        });
        await signInThroughUi(page, fixture.clientEmail, "/account/rewards");
        await expect(page).toHaveURL(/\/account\/rewards$/);
        await page.getByRole("button", { name: "Packages & memberships", exact: true }).click();
        const card = page
          .locator("div.rounded-xl")
          .filter({ has: page.getByRole("heading", { name, exact: true }) });
        await expect(card.getByText("Haircut", { exact: true })).toBeVisible();
        await card.getByRole("button", { name: "Purchase plan", exact: true }).click();
        await expect(card.getByLabel("Renewal payment", { exact: true })).toHaveValue("manual");
        await card.getByLabel("Renewal payment", { exact: true }).selectOption("automatic");
        await expect(
          card.getByRole("button", { name: "Create purchase", exact: true }),
        ).toBeDisabled();
        await card
          .getByRole("checkbox", {
            name: "I authorize automatic card payments of €10 each month until I stop renewal.",
            exact: true,
          })
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `recurring consent ${scheme}`);
        const created = page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/me/passes") && response.request().method() === "POST",
        );
        await card.getByRole("button", { name: "Create purchase", exact: true }).click();
        const purchase = await (await created).json();
        const detail = page.getByRole("region", { name: "View pass", exact: true });
        await detail.getByRole("button", { name: "Purchase receipt", exact: true }).click();
        const receipt = detail.getByRole("region", { name: "Receipt", exact: true });
        await receipt.getByRole("button", { name: "Continue to payment", exact: true }).click();
        await receipt
          .getByRole("button", { name: "Pay securely with Redsys", exact: true })
          .click();
        await expect(page).toHaveURL(/\/payments\//);
        expect(intercepted).toBe(1);
        await page.goto("/account/rewards");
        await page.getByRole("button", { name: "Packages & memberships", exact: true }).click();
        await page.getByLabel("Search pass name", { exact: true }).fill(name);
        await page.getByRole("button", { name: "View pass", exact: true }).click();
        await expect(
          detail.getByText(
            "Automatic card renewal is set up at the agreed price. You can stop future renewals here.",
            { exact: true },
          ),
        ).toBeVisible();
        expect(await page.locator("main").textContent()).not.toContain(fixture.reference);
        const renewed = await page.request.post("/api/__recurring-fixture/billing", {
          headers: { "x-recurring-fixture": "local-only" },
          data: { contractId: purchase.pass.id, advance: true },
        });
        expect(renewed.status()).toBe(200);
        expect(await renewed.json()).toMatchObject({ claimed: 1, succeeded: 1, uncertain: 0 });
        await page.reload();
        await page.getByRole("button", { name: "Packages & memberships", exact: true }).click();
        await page.getByLabel("Search pass name", { exact: true }).fill(name);
        await page.getByRole("button", { name: "View pass", exact: true }).click();
        await detail.getByRole("button", { name: "Purchase receipt", exact: true }).first().click();
        await expect(receipt.getByText(/Automatic membership card payment/)).toBeVisible();
        await expect(receipt.getByRole("status").filter({ hasText: /^Paid$/ })).toBeVisible();
        await detail
          .getByLabel("Cancellation reason", { exact: true })
          .fill("Stop future automatic renewals");
        await detail.getByRole("button", { name: "Stop renewal", exact: true }).click();
        await expect(
          detail.getByText(
            "Renewal stopped. Paid benefits remain valid through their recorded expiry.",
            { exact: true },
          ),
        ).toBeVisible();
        const current = await (await page.request.get(`/api/me/passes/${purchase.pass.id}`)).json();
        expect(current).toMatchObject({ cancelAtPeriodEnd: true, autoPayReady: false });
        expect(current.periods[0]).toMatchObject({ status: "active", availableUses: 2 });
        expect(JSON.stringify(current)).not.toContain(fixture.reference);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `cancelled recurring membership ${scheme}`);
      } finally {
        await owner.dispose();
      }
    });
  });
}
