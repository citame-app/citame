import { expect, test } from "@playwright/test";
import { clientPhotoFixture } from "../../api/test/client-photo-fixture";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`portfolio — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews private uploads before publication, protects newer edits and withdraws and erases public work", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(90000);
      const visitor = await browser.newContext({
        baseURL: fixture.baseURL,
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: page.viewportSize(),
      });
      const publicPage = await visitor.newPage();
      const caption = `Fixture work ${scheme} ${info.project.name}`;
      const alt = `Synthetic magenta pixels ${scheme} ${info.project.name}`;
      let photoId = "";
      try {
        await signInThroughUi(page, fixture.ownerEmail, "/admin/reputation?tab=portfolio");
        await page.getByRole("button", { name: "Add portfolio photo", exact: true }).click();
        let dialog = page.getByRole("dialog", { name: "Add portfolio photo", exact: true });
        await dialog.getByLabel("Photo file", { exact: true }).setInputFiles({
          name: "synthetic.jpg",
          mimeType: "image/jpeg",
          buffer: await clientPhotoFixture(),
        });
        await dialog.getByLabel("Caption", { exact: true }).fill(caption);
        await dialog.getByLabel("Image description", { exact: true }).fill(alt);
        await dialog
          .getByLabel("Treatment (optional)", { exact: true })
          .selectOption(fixture.haircut);
        await expectNoSeriousA11yViolations(page, `portfolio upload ${scheme}`);
        let lost = false;
        const keys: string[] = [];
        await page.route("**/api/admin/portfolio", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          keys.push(route.request().postDataJSON().idempotencyKey);
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          photoId = (await response.json()).id;
          return route.abort("failed");
        });
        await dialog.getByRole("button", { name: "Save private draft", exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByLabel("Caption", { exact: true })).toHaveValue(caption);
        await expect(dialog.getByLabel("Caption", { exact: true })).toBeDisabled();
        await dialog.getByRole("button", { name: "Save private draft", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect(keys).toHaveLength(2);
        expect(keys[1]).toBe(keys[0]);
        let card = page.getByRole("listitem").filter({ hasText: caption });
        await expect(card.getByText("Private draft", { exact: true })).toBeVisible();
        const savedNotice = page
          .getByText("Portfolio saved", { exact: true })
          .filter({ visible: true })
          .last();
        await expect(savedNotice).toBeVisible();
        await page.getByLabel("Dismiss", { exact: true }).filter({ visible: true }).last().click();
        await expect(savedNotice).toHaveCount(0);
        expect((await publicPage.request.get(`/api/portfolio/${photoId}/image`)).status()).toBe(
          404,
        );
        await card.getByRole("button", { name: "Review portfolio photo", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Review portfolio photo", exact: true });
        await expect(
          dialog.getByRole("button", { name: "Publish reviewed photo", exact: true }),
        ).toBeDisabled();
        await dialog
          .getByLabel(
            "I have permission from everyone shown and the rights to publish this photo and caption on the public salon website.",
          )
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `portfolio permission review ${scheme}`);
        await dialog.getByRole("button", { name: "Publish reviewed photo", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await publicPage.goto("/portfolio");
        await publicPage
          .getByLabel("Treatment (optional)", { exact: true })
          .selectOption(fixture.haircut);
        const image = publicPage.getByAltText(alt, { exact: true });
        await expect(image).toBeVisible();
        await expect
          .poll(() =>
            image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
          )
          .toBe(true);
        await publicPage.getByRole("button", { name: `View: ${caption}`, exact: true }).click();
        const detail = publicPage.getByRole("dialog", { name: caption, exact: true });
        await expect(
          detail.getByRole("link", { name: "Book this treatment", exact: true }),
        ).toBeVisible();
        await expectNoSeriousA11yViolations(publicPage, `public portfolio detail ${scheme}`);
        await detail.getByRole("link", { name: "Book this treatment", exact: true }).click();
        await expect(publicPage).toHaveURL(new RegExp(`/book\\?services=${fixture.haircut}`));
        await publicPage.goto("/portfolio");
        await expectNoHorizontalScroll(publicPage);
        await expectNoSeriousA11yViolations(publicPage, `public portfolio ${scheme}`);
        await publicPage.screenshot({
          path: `/tmp/sob-portfolio-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
        await card.getByRole("button", { name: "Review portfolio photo", exact: true }).click();
        dialog = page.getByRole("dialog", { name: "Review portfolio photo", exact: true });
        const current = (await (await page.request.get("/api/admin/portfolio")).json()).photos.find(
          (photo: { id: string }) => photo.id === photoId,
        );
        expect(
          (
            await page.request.put(`/api/admin/portfolio/${photoId}`, {
              data: {
                version: current.version,
                caption: `${caption} colleague`,
                alt,
                serviceId: fixture.haircut,
              },
              headers: { origin: fixture.baseURL },
            })
          ).ok(),
        ).toBe(true);
        await dialog.getByLabel("Caption", { exact: true }).fill(`${caption} stale draft`);
        await dialog.getByRole("button", { name: "Save private draft", exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        await expect(dialog.getByLabel("Caption", { exact: true })).toHaveValue(
          `${caption} stale draft`,
        );
        await dialog.getByRole("button", { name: "Close", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Discard this draft?", exact: true })
          .getByRole("button", { name: "Discard and reload", exact: true })
          .click();
        await expect(dialog).toHaveCount(0);
        await card.getByRole("button", { name: "Review portfolio photo", exact: true }).click();
        await expect(dialog.getByLabel("Caption", { exact: true })).toHaveValue(
          `${caption} colleague`,
        );
        await dialog.getByLabel("Caption", { exact: true }).fill(`${caption} revised`);
        await dialog.getByRole("button", { name: "Save private draft", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        card = page.getByRole("listitem").filter({ hasText: `${caption} revised` });
        await expect(
          page.getByText("Portfolio saved", { exact: true }).filter({ visible: true }).last(),
        ).toBeVisible();
        const reopen = card.getByRole("button", { name: "Review portfolio photo", exact: true });
        await reopen.scrollIntoViewIfNeeded();
        expect(
          await reopen.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return (
              document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest("button") === button
            );
          }),
        ).toBe(true);
        await reopen.click();
        await dialog
          .getByLabel(
            "I have permission from everyone shown and the rights to publish this photo and caption on the public salon website.",
          )
          .check();
        await dialog.getByRole("button", { name: "Publish reviewed photo", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        expect((await publicPage.request.get(`/api/portfolio/${photoId}/image`)).status()).toBe(
          200,
        );
        await card.getByRole("button", { name: "Review portfolio photo", exact: true }).click();
        const unpublish = dialog.getByRole("button", { name: "Unpublish photo", exact: true });
        // A just-created success toast must leave the real action hit target reachable.
        expect(
          await unpublish.evaluate((button) => {
            const rect = button.getBoundingClientRect();
            return (
              document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest("button") === button
            );
          }),
        ).toBe(true);
        await unpublish.click();
        await expect(dialog).toHaveCount(0);
        expect((await publicPage.request.get(`/api/portfolio/${photoId}/image`)).status()).toBe(
          404,
        );
        await publicPage.reload();
        await expect(
          publicPage.getByRole("heading", { name: "No published work yet", exact: true }),
        ).toBeVisible();
        await page.getByRole("radio", { name: "Español", exact: true }).check();
        await card.getByRole("button", { name: "Revisar foto del portfolio", exact: true }).click();
        const spanish = page.getByRole("dialog", {
          name: "Revisar foto del portfolio",
          exact: true,
        });
        await spanish
          .getByRole("button", { name: "Borrar foto del portfolio", exact: true })
          .click();
        const removal = page.getByRole("dialog", {
          name: "Borrar foto del portfolio",
          exact: true,
        });
        await expectNoSeriousA11yViolations(page, `Spanish portfolio erasure ${scheme}`);
        await removal
          .getByRole("button", { name: "Borrar foto del portfolio", exact: true })
          .click();
        await expect(removal).toHaveCount(0);
        await expect(spanish).toHaveCount(0);
        await expect(page.getByText(`${caption} revised`, { exact: true })).toHaveCount(0);
      } finally {
        if (photoId) {
          const response = await page.request.get("/api/admin/portfolio");
          if (response.ok()) {
            const photo = (await response.json()).photos.find(
              (photo: { id: string }) => photo.id === photoId,
            );
            if (photo)
              await page.request.post(`/api/admin/portfolio/${photoId}/remove`, {
                data: { version: photo.version, confirmation: true },
                headers: { origin: fixture.baseURL },
              });
          }
        }
        await visitor.close();
      }
    });
  });
