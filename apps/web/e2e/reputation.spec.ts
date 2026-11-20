import { expect, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi, switchLocale } from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`reviews — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("recovers a lost submission, moderates and replies without disclosing private treatments, then withdraws", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(90000);
      const owner = await browser.newContext({
        baseURL: fixture.baseURL,
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: page.viewportSize(),
      });
      const visitor = await browser.newContext({
        baseURL: fixture.baseURL,
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: page.viewportSize(),
      });
      const admin = await owner.newPage();
      const publicPage = await visitor.newPage();
      const body = `A relaxing fixture visit ${scheme} ${info.project.name}`;
      const publicName = `A. ${scheme} ${info.project.name}`;
      let reviewId = "";
      try {
        await signInThroughUi(page, fixture.clientEmail, "/account/reviews");
        await page.getByRole("button", { name: "Write a review", exact: true }).first().click();
        let dialog = page.getByRole("dialog", { name: "Write a review", exact: true });
        await dialog.getByLabel("Public name", { exact: true }).fill(publicName);
        await dialog.getByLabel("Rating out of 5", { exact: true }).selectOption("4");
        await dialog.getByLabel("Your review", { exact: true }).fill(body);
        await expect(dialog.getByLabel("Show the booked treatments publicly")).not.toBeChecked();
        await expect(
          dialog.getByRole("button", { name: "Send for moderation", exact: true }),
        ).toBeDisabled();
        await dialog
          .getByLabel("I agree to publish this name, rating and review on the salon website.")
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `review editor ${scheme}`);
        let lost = false;
        const keys: string[] = [];
        await page.route("**/api/me/reviews", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          keys.push(route.request().postDataJSON().idempotencyKey);
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          reviewId = (await response.json()).id;
          return route.abort("failed");
        });
        await dialog.getByRole("button", { name: "Send for moderation", exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByLabel("Your review", { exact: true })).toHaveValue(body);
        await expect(dialog.getByLabel("Your review", { exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "Send for moderation", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
        const ownCard = page.getByRole("listitem").filter({ hasText: body });
        await expect(ownCard.getByText("Awaiting moderation", { exact: true })).toBeVisible();
        await publicPage.goto("/reviews");
        await expect(publicPage.getByText(body, { exact: true })).toHaveCount(0);
        await signInThroughUi(admin, fixture.ownerEmail, "/admin/reputation");
        const adminCard = admin.getByRole("listitem").filter({ hasText: body });
        await adminCard.getByRole("button", { name: "Review and moderate", exact: true }).click();
        let moderation = admin.getByRole("dialog", { name: "Review and moderate", exact: true });
        await expectNoSeriousA11yViolations(admin, `review moderation ${scheme}`);
        await moderation
          .getByRole("button", { name: "Publish reviewed content", exact: true })
          .click();
        await expect(moderation).toHaveCount(0);
        await publicPage.reload();
        await expect(publicPage.getByText(body, { exact: true })).toBeVisible();
        await expect(publicPage.getByText(publicName, { exact: true })).toBeVisible();
        await expect(publicPage.getByText("Fixture haircut", { exact: true })).toHaveCount(0);
        await expect(
          publicPage.getByText("4 out of 5 · 1 published review", { exact: true }),
        ).toBeVisible();
        await admin.getByLabel("Review status", { exact: true }).selectOption("published");
        await adminCard.getByRole("button", { name: "Review and moderate", exact: true }).click();
        moderation = admin.getByRole("dialog", { name: "Review and moderate", exact: true });
        await moderation
          .getByLabel("Public salon reply", { exact: true })
          .fill("Thank you for visiting.");
        await moderation.getByRole("button", { name: "Save public reply", exact: true }).click();
        await expect(moderation).toHaveCount(0);
        await publicPage.reload();
        await expect(
          publicPage.getByText("Thank you for visiting.", { exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(publicPage);
        await expectNoSeriousA11yViolations(publicPage, `public review ${scheme}`);
        await publicPage.screenshot({
          path: `/tmp/sob-reviews-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
        await page.getByRole("button", { name: "Reload reviews", exact: true }).click();
        await ownCard.getByRole("button", { name: "Edit review", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Edit review", exact: true });
        await dialog.getByLabel("Your review", { exact: true }).fill("Unsent correction");
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Discard this draft?", exact: true })
          .getByRole("button", { name: "Keep editing", exact: true })
          .click();
        await expect(dialog.getByLabel("Your review", { exact: true })).toHaveValue(
          "Unsent correction",
        );
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Discard this draft?", exact: true })
          .getByRole("button", { name: "Discard and reload", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await switchLocale(page, "Español");
        await ownCard.getByRole("button", { name: "Retirar reseña", exact: true }).click();
        const withdrawal = page.getByRole("dialog", { name: "Retirar reseña", exact: true });
        await expectNoSeriousA11yViolations(page, `withdrawal in Spanish ${scheme}`);
        await withdrawal.getByRole("button", { name: "Retirar reseña", exact: true }).click();
        await expect(withdrawal).toHaveCount(0);
        await expect(page.getByText(body, { exact: true })).toHaveCount(0);
        await publicPage.reload();
        await expect(publicPage.getByText(body, { exact: true })).toHaveCount(0);
        await expect(
          publicPage.getByText("No published reviews yet", { exact: true }),
        ).toBeVisible();
      } finally {
        if (reviewId) {
          const current = await page.request.get("/api/me/reviews");
          if (current.ok()) {
            const review = (await current.json()).visits.find(
              (visit: { review: { id: string } | null }) => visit.review?.id === reviewId,
            )?.review;
            if (review && review.status !== "withdrawn")
              await page.request.post(`/api/me/reviews/${reviewId}/withdraw`, {
                data: { version: review.version },
                headers: { origin: fixture.baseURL },
              });
          }
        }
        await owner.close();
        await visitor.close();
      }
    });
  });
