import { expect, request, test } from "@playwright/test";
import { clientPhotoFixture } from "../../api/test/client-photo-fixture";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`private client photos — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("uploads without enlargement, recovers an uncertain response, reviews a conflicting edit and removes private pixels", async ({
      page,
    }) => {
      let clientId = "";
      try {
        await signInThroughUi(page, fixture.ownerEmail, "/admin/clients");
        await expect(
          page.getByRole("button", { name: "Import clients", exact: true }),
        ).toBeVisible();
        const token = crypto.randomUUID().slice(0, 8);
        const csv = `name,email\nPhoto ${token},photo-${token}@example.invalid`;
        const preview = await page.request.post("/api/admin/clients/import/preview", {
          headers: { origin: fixture.baseURL },
          data: { csv },
        });
        expect(preview.ok(), await preview.text()).toBe(true);
        const imported = await page.request.post("/api/admin/clients/import", {
          headers: { origin: fixture.baseURL },
          data: {
            csv,
            reviewHash: (await preview.json()).reviewHash,
            rows: [2],
            idempotencyKey: crypto.randomUUID(),
          },
        });
        expect(imported.status(), await imported.text()).toBe(201);
        clientId = (await imported.json()).clientIds[0];
        await page.goto(`/admin/clients/${clientId}`);
        await page.getByRole("button", { name: "Add private photo", exact: true }).click();
        const upload = page.getByRole("dialog", { name: "Add private photo", exact: true });
        await expect(
          upload.getByRole("button", { name: "Save photo", exact: true }),
        ).toBeDisabled();
        await upload.getByLabel("Choose photo", { exact: true }).setInputFiles({
          name: "synthetic-private.jpg",
          mimeType: "image/jpeg",
          buffer: await clientPhotoFixture(),
        });
        await upload.getByLabel("Photo description", { exact: true }).fill("Before colour");
        await expect(upload.getByRole("img", { name: "Photo preview", exact: true })).toBeVisible();
        await expect(
          upload.getByRole("button", { name: "Save photo", exact: true }),
        ).toBeDisabled();
        await upload
          .getByRole("checkbox", {
            name: "I have permission to store this photo in the private client record.",
            exact: true,
          })
          .check();
        await expectNoSeriousA11yViolations(page, `private photo upload ${scheme}`);
        const attempts: unknown[] = [];
        let lost = false;
        let first: { id: string; version: number; width: number; height: number } | undefined;
        await page.route(`**/api/admin/clients/${clientId}/photos`, async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON());
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          first = await response.json();
          await route.abort("connectionreset");
        });
        await upload.getByRole("button", { name: "Save photo", exact: true }).click();
        await expect(upload.getByRole("alert")).toBeVisible();
        const recovered = page.waitForResponse(
          (r) => r.url().endsWith(`/clients/${clientId}/photos`) && r.request().method() === "POST",
        );
        await upload.getByRole("button", { name: "Save photo", exact: true }).click();
        const response = await recovered;
        expect(response.status(), await response.text()).toBe(201);
        const photo = await response.json();
        expect(photo).toEqual(first);
        expect(photo).toMatchObject({ width: 640, height: 400 });
        expect(attempts[1]).toEqual(attempts[0]);
        await page.getByRole("button", { name: "Open photo: Before colour", exact: true }).click();
        const details = page.getByRole("dialog", { name: "Photo details", exact: true });
        await expect(
          details.getByRole("img", { name: "Before colour", exact: true }),
        ).toBeVisible();
        await expect(details.getByRole("img")).toHaveJSProperty("naturalWidth", 640);
        const publicContext = await request.newContext({ baseURL: fixture.baseURL });
        expect(
          (
            await publicContext.get(`/api/admin/clients/${clientId}/photos/${photo.id}/image`)
          ).status(),
        ).toBe(401);
        await publicContext.dispose();
        await details.getByLabel("Photo description", { exact: true }).fill("After colour");
        const external = await page.request.patch(
          `/api/admin/clients/${clientId}/photos/${photo.id}`,
          {
            headers: { origin: fixture.baseURL },
            data: { version: photo.version, caption: "Updated by a colleague", capturedOn: null },
          },
        );
        expect(external.status(), await external.text()).toBe(200);
        await details.getByRole("button", { name: "Save photo", exact: true }).click();
        await expect(details.getByRole("alert")).toContainText("Photo details changed");
        await expect(details.getByLabel("Photo description", { exact: true })).toHaveValue(
          "After colour",
        );
        await details.getByRole("button", { name: "Reload photo details", exact: true }).click();
        await expect(details.getByLabel("Photo description", { exact: true })).toHaveValue(
          "Updated by a colleague",
        );
        await details.getByLabel("Photo description", { exact: true }).fill("After colour");
        await details.getByRole("button", { name: "Save photo", exact: true }).click();
        await expect(details).toHaveCount(0);
        await page.getByRole("radio", { name: "Español", exact: true }).check({ force: true });
        await page.getByRole("button", { name: "Abrir foto: After colour", exact: true }).click();
        const spanish = page.getByRole("dialog", { name: "Detalles de la foto", exact: true });
        await expect(
          page.getByText("Private photo saved", { exact: true }).filter({ visible: true }).last(),
        ).toBeVisible();
        // Inspect the live hit target while the success notice is still on screen.
        // Locators and DOM geometry keep this independent of viewport coordinates.
        expect(
          await spanish
            .getByRole("button", { name: "Eliminar foto", exact: true })
            .evaluate((button) => {
              const rect = button.getBoundingClientRect();
              return (
                document
                  .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                  ?.closest("button") === button
              );
            }),
        ).toBe(true);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Spanish private photo ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-client-photos-es-${scheme}-${test.info().project.name}.png`,
          animations: "disabled",
        });
        await spanish.getByRole("button", { name: "Eliminar foto", exact: true }).click();
        await page
          .getByRole("button", { name: "Eliminar foto permanentemente", exact: true })
          .click();
        await expect(
          page.getByText("Todavía no hay fotos privadas.", { exact: true }),
        ).toBeVisible();
        expect(
          (
            await page.request.get(`/api/admin/clients/${clientId}/photos/${photo.id}/image`)
          ).status(),
        ).toBe(404);
      } finally {
        if (clientId) {
          const photos = await page.request.get(`/api/admin/clients/${clientId}/photos`);
          if (photos.ok())
            for (const photo of (await photos.json()).photos)
              await page.request.delete(
                `/api/admin/clients/${clientId}/photos/${photo.id}?version=${photo.version}`,
                { headers: { origin: fixture.baseURL } },
              );
          await page.request.delete(`/api/admin/clients/${clientId}`, {
            headers: { origin: fixture.baseURL },
          });
        }
      }
    });
  });
}
