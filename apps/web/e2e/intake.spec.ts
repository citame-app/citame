import { expect, request, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
  switchLocale,
} from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`versioned forms — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("the team records reviewed paper responses once and customers can read their original private copy", async ({
      page,
    }) => {
      await signInThroughUi(page, fixture.ownerEmail, "/admin/clients");
      await expect(page.getByRole("button", { name: "Import clients", exact: true })).toBeVisible();
      const directory = await (
        await page.request.get("/api/admin/clients?search=Recurring%20fixture%20client")
      ).json();
      const clientId = directory.clients[0].id;
      const field = crypto.randomUUID();
      const title = `Paper preferences ${crypto.randomUUID().slice(0, 8)}`;
      const created = await page.request.post("/api/admin/intake-forms", {
        headers: { origin: fixture.baseURL },
        data: {
          idempotencyKey: crypto.randomUUID(),
          definition: {
            title,
            fields: [{ id: field, kind: "boolean", label: "Previous treatment?", required: true }],
            allServices: false,
            serviceIds: [fixture.haircut],
            allowTeamResponses: true,
          },
        },
      });
      expect(created.status()).toBe(201);
      let current = await created.json();
      const publish = await page.request.post(`/api/admin/intake-forms/${current.id}/publish`, {
        headers: { origin: fixture.baseURL },
        data: { version: current.version },
      });
      expect(publish.ok()).toBe(true);
      current = await publish.json();
      try {
        await page.goto(`/admin/clients/${clientId}`);
        await page.getByRole("button", { name: "Documents and consultation", exact: true }).click();
        await page.getByRole("button", { name: "Record a response", exact: true }).click();
        const sheet = page.getByRole("dialog", { name: "Record a response", exact: true });
        await sheet.getByRole("checkbox", { name: "Haircut", exact: true }).check();
        const form = sheet.getByRole("group", { name: title, exact: true });
        await form
          .getByRole("checkbox", { name: "Complete this optional form", exact: true })
          .check();
        await form.getByLabel("Previous treatment?", { exact: true }).selectOption("false");
        const submit = sheet.getByRole("button", { name: "Save confirmed responses", exact: true });
        await expect(submit).toBeDisabled();
        await form
          .getByRole("checkbox", {
            name: "I have reviewed the client's responses with them and have permission to record them.",
            exact: true,
          })
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `team response ${scheme}`);
        let lost = false;
        const attempts: string[] = [];
        await page.route(`**/api/admin/clients/${clientId}/intake`, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON().idempotencyKey);
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          return route.abort("failed");
        });
        await submit.click();
        await expect(sheet.getByRole("alert")).toBeVisible();
        await expect(form.getByLabel("Previous treatment?", { exact: true })).toHaveValue("false");
        await submit.click();
        await expect(sheet).toHaveCount(0);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
        const history = await (
          await page.request.get(`/api/admin/clients/${clientId}/intake`)
        ).json();
        expect(
          history.submissions.filter((value: { formId: string }) => value.formId === current.id),
        ).toHaveLength(1);
        await page
          .getByRole("listitem")
          .filter({ hasText: title })
          .getByRole("button", { name: "View response", exact: true })
          .click();
        const recorded = page.getByRole("dialog", { name: title, exact: true });
        await expect(recorded.getByText("No", { exact: true })).toBeVisible();
        await expect(recorded.getByText(/Recorded by the team/)).toBeVisible();
        await expectNoSeriousA11yViolations(page, `paper record ${scheme}`);
        await recorded.getByRole("button", { name: "Close response", exact: true }).click();
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(page, fixture.clientEmail, "/account/profile");
        await page
          .getByRole("listitem")
          .filter({ hasText: title })
          .getByRole("button", { name: "View response", exact: true })
          .click();
        await expect(
          page.getByRole("dialog", { name: title, exact: true }).getByText("No", { exact: true }),
        ).toBeVisible();
      } finally {
        const owner = await request.newContext({
          baseURL: fixture.baseURL,
          extraHTTPHeaders: { origin: fixture.baseURL },
        });
        await owner.post("/api/auth/sign-in/email", {
          data: { email: fixture.ownerEmail, password: fixture.password },
        });
        await owner.post(`/api/admin/intake-forms/${current.id}/archive`, {
          data: { version: current.version },
        });
        await owner.dispose();
      }
    });
    test("publishes reviewed questions, rejects changed terms and recovers a booking with its original private answers", async ({
      page,
    }) => {
      test.setTimeout(120000);
      const owner = await request.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      let formId = "";
      let booked: { id: string; version: number } | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        await signInThroughUi(page, fixture.ownerEmail, "/admin/settings");
        await page.getByRole("link", { name: "Forms and consent", exact: true }).click();
        await page.getByRole("heading", { name: "Forms and consent", exact: true }).waitFor();
        await page.getByRole("button", { name: "New form", exact: true }).click();
        const title = `Visit preferences ${crypto.randomUUID().slice(0, 8)}`;
        await page.getByLabel("Form title", { exact: true }).fill(title);
        await page.getByLabel("Form purpose", { exact: true }).selectOption("waiver");
        await page
          .getByLabel("Introduction and terms", { exact: true })
          .fill("Local fixture: preferences for the reviewed visit.");
        await page
          .getByRole("checkbox", { name: "Require before confirming a booking", exact: true })
          .check();
        await page.getByRole("checkbox", { name: "Apply to every service", exact: true }).uncheck();
        await page
          .getByRole("group", { name: "Applicable services", exact: true })
          .getByRole("checkbox", { name: "Haircut", exact: true })
          .check();
        const configure = async (number: number, label: string, kind: string) => {
          if (number > 1)
            await page.getByRole("button", { name: "Add question", exact: true }).click();
          const group = page.getByRole("group", { name: `Question ${number}`, exact: true });
          await group.getByLabel("Question text", { exact: true }).fill(label);
          await group.getByLabel("Answer type", { exact: true }).selectOption(kind);
          await group.getByRole("checkbox", { name: "Answer required", exact: true }).check();
        };
        await configure(1, "Style preference", "text");
        await configure(2, "Previous treatment?", "boolean");
        await configure(3, "Sessions", "number");
        await configure(4, "I confirm these visit preferences.", "consent");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `form builder ${scheme}`);
        const creating = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/intake-forms") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Save draft", exact: true }).click();
        const created = await creating;
        expect(created.status(), await created.text()).toBe(201);
        formId = (await created.json()).id;
        await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "Review and publish", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Review and publish", exact: true });
        const publish = review.getByRole("button", { name: "Publish this version", exact: true });
        await expect(publish).toBeVisible();
        await publish.scrollIntoViewIfNeeded();
        // A success notice must leave the dialog's action reachable while it remains visible.
        await expect(page.getByText("Draft saved", { exact: true })).toBeVisible();
        expect(
          await publish.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return (
              document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest("button") === button
            );
          }),
        ).toBe(true);
        await expectNoSeriousA11yViolations(page, `publication review ${scheme}`);
        await publish.click();
        await expect(review).toHaveCount(0);
        await expect(page.getByText("Published · Version 1", { exact: true })).toBeVisible();
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: fixture.baseURL },
          data: {},
        });
        await signInThroughUi(page, fixture.clientEmail, "/book");
        await page.getByRole("checkbox", { name: "Haircut", exact: true }).check();
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(page, "Stylist A");
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await expect(page).toHaveURL(/\/book\/review/);
        const form = page.getByRole("group", { name: title, exact: true });
        const confirm = page.getByRole("button", { name: "Confirm booking", exact: true });
        await expect(confirm).toBeDisabled();
        const answer = async () => {
          await form
            .getByLabel("Style preference", { exact: true })
            .fill("Keep this original private answer");
          await form.getByLabel("Previous treatment?", { exact: true }).selectOption("false");
          await form.getByLabel("Sessions", { exact: true }).fill("0");
          await form
            .getByRole("checkbox", { name: "I confirm these visit preferences.", exact: true })
            .check();
          await form
            .getByRole("checkbox", {
              name: "I have reviewed these questions and confirm my answers.",
              exact: true,
            })
            .check();
        };
        await answer();
        const directory = await (await owner.get("/api/admin/intake-forms")).json();
        const current = directory.forms.find((value: { id: string }) => value.id === formId);
        const edited = await owner.put(`/api/admin/intake-forms/${formId}`, {
          data: {
            version: current.version,
            definition: {
              ...current.draft,
              description: "Local fixture: revised visit preferences.",
            },
          },
        });
        expect(edited.ok()).toBe(true);
        expect(
          (
            await owner.post(`/api/admin/intake-forms/${formId}/publish`, {
              data: { version: (await edited.json()).version },
            })
          ).ok(),
        ).toBe(true);
        const rejected = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await confirm.click();
        expect((await rejected).status()).toBe(409);
        await expect(form.getByText(/Version 2/)).toBeVisible();
        await expect(confirm).toBeDisabled();
        await expect(
          form.getByRole("checkbox", {
            name: "I have reviewed these questions and confirm my answers.",
            exact: true,
          }),
        ).not.toBeChecked();
        await answer();
        await expectNoHorizontalScroll(page);
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expectNoSeriousA11yViolations(page, `booking questions ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-intake-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        let lost = false;
        const attempts: string[] = [];
        await page.route("**/api/appointments", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON().id);
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          const body = await response.json();
          expect(JSON.stringify(body)).not.toContain("Keep this original private answer");
          booked = body;
          return route.abort("failed");
        });
        await confirm.click();
        await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeVisible();
        await confirm.click();
        await expect(page).toHaveURL(/\/book\/confirmed\//);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toBe(attempts[0]);
        const history = await (await page.request.get("/api/me/intake")).json();
        const responses = history.submissions.filter(
          (value: { formId: string }) => value.formId === formId,
        );
        expect(responses).toHaveLength(1);
        await page.goto("/account/profile");
        await page
          .getByRole("listitem")
          .filter({ hasText: title })
          .getByRole("button", { name: "View response", exact: true })
          .click();
        const recorded = page.getByRole("dialog", { name: title, exact: true });
        await expect(
          recorded.getByText("Keep this original private answer", { exact: true }),
        ).toBeVisible();
        await expect(recorded.getByText("No", { exact: true })).toBeVisible();
        await expect(recorded.getByText("0", { exact: true })).toBeVisible();
        await expect(recorded.getByText(/Completed by the client/)).toBeVisible();
        await expectNoSeriousA11yViolations(page, `frozen response ${scheme}`);
        await recorded.getByRole("button", { name: "Close response", exact: true }).click();
        await switchLocale(page, "Español");
        await page
          .getByRole("listitem")
          .filter({ hasText: title })
          .getByRole("button", { name: "Ver respuesta", exact: true })
          .click();
        await expect(
          page
            .getByRole("dialog", { name: title, exact: true })
            .getByText(/Completado por el cliente/),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Spanish response ${scheme}`);
      } finally {
        if (booked)
          await owner.patch(`/api/appointments/${booked.id}`, {
            data: { version: booked.version, status: "cancelled" },
          });
        if (formId) {
          const forms = await (await owner.get("/api/admin/intake-forms")).json();
          const latest = forms.forms.find((value: { id: string }) => value.id === formId);
          if (latest?.active)
            await owner.post(`/api/admin/intake-forms/${formId}/archive`, {
              data: { version: latest.version },
            });
        }
        await owner.dispose();
      }
    });
  });
}
