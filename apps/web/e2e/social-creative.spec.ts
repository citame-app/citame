import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import jsQR from "jsqr";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

async function exportArtwork(page: Page, image: Locator, path: string, height: number) {
  await expect(image).toBeVisible();
  await expect(page.getByRole("button", { name: "Download PNG", exact: true })).toBeDisabled();
  await page
    .getByLabel(
      "I have reviewed the image, source permission and complete caption before exporting.",
      { exact: true },
    )
    .check();
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG", exact: true }).click();
  await (await event).saveAs(path);
  const png = await readFile(path);
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const pixels = await image.evaluate(async (node: HTMLImageElement) => {
    await node.decode();
    const canvas = document.createElement("canvas");
    canvas.width = 300;
    canvas.height = 320;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    // Decode the complete exported QR and its quiet zone in the lower-right artwork area.
    context.drawImage(
      node,
      node.naturalWidth - 300,
      node.naturalHeight - 320,
      300,
      320,
      0,
      0,
      300,
      320,
    );
    return {
      width: node.naturalWidth,
      height: node.naturalHeight,
      data: Array.from(context.getImageData(0, 0, 300, 320).data),
    };
  });
  expect(pixels.width).toBe(1080);
  expect(pixels.height).toBe(height);
  expect(png).toEqual(
    Buffer.from((await image.getAttribute("src"))?.split(",")[1] ?? "", "base64"),
  );
  const decoded = jsQR(new Uint8ClampedArray(pixels.data), 300, 320);
  expect(decoded?.data.startsWith(`${fixture.baseURL}/book`)).toBe(true);
}
async function prepare(page: Page, title: string) {
  await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
  const image = page.getByAltText(`Creative preview: ${title}`, { exact: true });
  await expect(image).toBeVisible();
  return image;
}
for (const scheme of ["light", "dark"] as const)
  test.describe(`social creative — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("exports complete source terms, rejects changed prices and stops review exports after client revocation", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(120000);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const account = await browser.newContext({
        baseURL: fixture.baseURL,
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: page.viewportSize(),
      });
      const customer = await account.newPage();
      const body =
        `Fixture feedback ${scheme} ${info.project.name}. A comfortable visit with clear explanations. `.repeat(
          7,
        );
      const publicName = `A. ${"fixture ".repeat(6)}${scheme} ${info.project.name}`;
      let reviewId = "";
      let promotion: { id: string; version: number } | undefined;
      const promoInput = {
        code: `SOCIAL_${scheme}_${info.project.name}`.toUpperCase(),
        name: `Fixture offer ${scheme} ${info.project.name}`,
        kind: "percent",
        value: 2000,
        minimumSpendCents: 1000,
        maximumDiscountCents: 500,
        usageLimit: 50,
        perClientLimit: 1,
        startsAt: new Date(Date.now() - 86400000).toISOString(),
        endsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
        eligibleKinds: ["service"],
        serviceIds: [fixture.haircut],
        active: true,
        version: null,
      };
      let originalPrice = 2000;
      try {
        await signInThroughUi(page, fixture.ownerEmail, "/admin/reputation?tab=creative");
        const catalog = await (await page.request.get("/api/services")).json();
        originalPrice = catalog.services.find(
          (service: { id: string }) => service.id === fixture.haircut,
        ).priceCents;
        await page.getByLabel("Choose a treatment", { exact: true }).selectOption(fixture.haircut);
        await page
          .getByLabel("Colour palette", { exact: true })
          .selectOption(scheme === "dark" ? "ink" : "cream");
        await prepare(page, "Haircut");
        await page
          .getByLabel(
            "I have reviewed the image, source permission and complete caption before exporting.",
            { exact: true },
          )
          .check();
        expect(
          (
            await page.request.patch(`/api/admin/services/${fixture.haircut}`, {
              headers: { origin: fixture.baseURL },
              data: { priceCents: 2500 },
            })
          ).ok(),
        ).toBe(true);
        await page.getByRole("button", { name: "Download PNG", exact: true }).click();
        await expect(
          page.getByText(
            "The source changed or its permission is no longer available. Reload sources and prepare a new preview.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(page.getByLabel("Choose a treatment", { exact: true })).toHaveValue(
          fixture.haircut,
        );
        await page.getByRole("button", { name: "Reload sources", exact: true }).click();
        await expect(page.getByText("€25 · 45m", { exact: true })).toBeVisible();
        let image = await prepare(page, "Haircut");
        await exportArtwork(
          page,
          image,
          `/tmp/sob-social-service-${scheme}-${info.project.name}.png`,
          1350,
        );
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `service creative ${scheme}`);
        expect(
          (
            await page.request.patch(`/api/admin/services/${fixture.haircut}`, {
              headers: { origin: fixture.baseURL },
              data: { priceCents: originalPrice },
            })
          ).ok(),
        ).toBe(true);
        await page.getByRole("button", { name: "Reload sources", exact: true }).click();
        await expect(page.getByText("€20 · 45m", { exact: true })).toBeVisible();
        const offer = await page.request.post("/api/admin/rewards/promotions", {
          headers: { origin: fixture.baseURL },
          data: promoInput,
        });
        expect(offer.status(), await offer.text()).toBe(201);
        promotion = await offer.json();
        if (!promotion) throw new Error("Missing promotion");
        await page.getByLabel("Template", { exact: true }).selectOption("promotion");
        await page.getByLabel("Choose an offer", { exact: true }).selectOption(promotion.id);
        await page.getByLabel("Image format", { exact: true }).selectOption("square");
        await page.getByRole("button", { name: "Prepare preview", exact: true }).click();
        await expect(
          page.getByText(
            "This content will not fit at a readable size. Choose a larger format. Offer terms are never truncated.",
            { exact: true },
          ),
        ).toBeVisible();
        await page.getByLabel("Image format", { exact: true }).selectOption("story");
        image = await prepare(page, promoInput.name);
        const caption = page.getByLabel("Complete caption and image description", { exact: true });
        const full = await caption.inputValue();
        for (const condition of [
          promoInput.code,
          "€10",
          "€5",
          "1 use per client",
          "50 uses total",
          "Until",
          "Cannot combine",
        ])
          expect(full).toContain(condition);
        await exportArtwork(
          page,
          image,
          `/tmp/sob-social-offer-${scheme}-${info.project.name}.png`,
          1920,
        );
        await page.getByRole("button", { name: "Copy complete caption", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(full);
        await expectNoSeriousA11yViolations(page, `complete offer creative ${scheme}`);
        await signInThroughUi(customer, fixture.clientEmail, "/account/reviews");
        await customer.getByRole("button", { name: "Write a review", exact: true }).first().click();
        const form = customer.getByRole("dialog", { name: "Write a review", exact: true });
        await form.getByLabel("Public name", { exact: true }).fill(publicName);
        await form.getByLabel("Your review", { exact: true }).fill(body);
        const permission = form.getByLabel(
          "Allow the salon to reuse this review and public name in its own social posts (optional).",
          { exact: true },
        );
        await expect(permission).not.toBeChecked();
        await permission.check();
        await form
          .getByLabel("I agree to publish this name, rating and review on the salon website.", {
            exact: true,
          })
          .check();
        await form.getByRole("button", { name: "Send for moderation", exact: true }).click();
        await expect(form).toHaveCount(0);
        const own = await (await customer.request.get("/api/me/reviews")).json();
        reviewId = own.visits.find(
          (visit: { review: { publicName: string } | null }) =>
            visit.review?.publicName === publicName,
        ).review.id;
        await page.getByRole("tab", { name: "Reviews", exact: true }).click();
        const card = page.getByRole("listitem").filter({ hasText: publicName });
        await card.getByRole("button", { name: "Review and moderate", exact: true }).click();
        const moderation = page.getByRole("dialog", { name: "Review and moderate", exact: true });
        await moderation
          .getByRole("button", { name: "Publish reviewed content", exact: true })
          .click();
        await expect(moderation).toHaveCount(0);
        await page.getByRole("tab", { name: "Social creative", exact: true }).click();
        await page.getByLabel("Template", { exact: true }).selectOption("review");
        await page.getByLabel("Choose a consented review", { exact: true }).selectOption(reviewId);
        image = await prepare(page, "A client’s experience");
        expect(
          await page
            .getByLabel("Complete caption and image description", { exact: true })
            .inputValue(),
        ).toContain(body.trim());
        await exportArtwork(
          page,
          image,
          `/tmp/sob-social-review-${scheme}-${info.project.name}.png`,
          1350,
        );
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `consented review creative ${scheme}`);
        // Keep the reviewed directory stale; the source permission endpoint remains real.
        const staleDirectory = await (
          await page.request.get("/api/admin/reviews?status=published")
        ).json();
        await page.route("**/api/admin/reviews?status=published", (route) =>
          route.fulfill({ json: staleDirectory }),
        );
        await customer.getByRole("button", { name: "Reload reviews", exact: true }).click();
        await customer.getByRole("radio", { name: "Español", exact: true }).check();
        const ownCard = customer.getByRole("listitem").filter({ hasText: publicName });
        await ownCard
          .getByRole("button", { name: "Retirar permiso para redes", exact: true })
          .click();
        const revoke = customer.getByRole("dialog", {
          name: "Retirar permiso para redes",
          exact: true,
        });
        await expectNoSeriousA11yViolations(customer, `Spanish social revocation ${scheme}`);
        await revoke
          .getByRole("button", { name: "Retirar permiso para redes", exact: true })
          .click();
        await expect(revoke).toHaveCount(0);
        await expect(ownCard.getByText("Publicada", { exact: true })).toBeVisible();
        await expect(
          ownCard.getByText("No se permite la reutilización en redes", { exact: true }),
        ).toBeVisible();
        let exports = 0;
        page.on("download", () => {
          exports++;
        });
        await page.getByRole("button", { name: "Download PNG", exact: true }).click();
        await expect(
          page.getByText(
            "The source changed or its permission is no longer available. Reload sources and prepare a new preview.",
            { exact: true },
          ),
        ).toBeVisible();
        expect(exports).toBe(0);
        expect((await page.request.get(`/api/admin/reviews/${reviewId}/social`)).status()).toBe(
          404,
        );
        await page.screenshot({
          path: `/tmp/sob-social-revoked-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
      } finally {
        await page.request.patch(`/api/admin/services/${fixture.haircut}`, {
          headers: { origin: fixture.baseURL },
          data: { priceCents: originalPrice },
        });
        if (promotion)
          await page.request.put(`/api/admin/rewards/promotions/${promotion.id}`, {
            headers: { origin: fixture.baseURL },
            data: { ...promoInput, active: false, version: promotion.version },
          });
        if (reviewId) {
          const response = await customer.request.get("/api/me/reviews");
          if (response.ok()) {
            const row = (await response.json()).visits.find(
              (visit: { review: { id: string } | null }) => visit.review?.id === reviewId,
            )?.review;
            if (row && row.status !== "withdrawn")
              await customer.request.post(`/api/me/reviews/${reviewId}/withdraw`, {
                headers: { origin: fixture.baseURL },
                data: { version: row.version },
              });
          }
        }
        await account.close();
      }
    });
  });
