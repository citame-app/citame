import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import jsQR from "jsqr";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi } from "./helpers";

const parents: Server[] = [];
const exec = promisify(execFile);
test.beforeAll(async () => {
  for (const port of [4274, 4275]) {
    const server = createServer((request, response) => {
      const src = new URL(request.url ?? "/", "http://localhost").searchParams.get("src") ?? "";
      const escaped = src
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;")
        .replaceAll("<", "&lt;");
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<!doctype html><html lang="en"><head><title>Embedding fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:16px sans-serif}h1{font-size:18px;margin:16px}iframe{width:100%;height:1000px;border:0}</style></head><body><main><h1>Embedding fixture</h1><iframe title="Fixture booking widget" src="${escaped}"></iframe></main></body></html>`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    parents.push(server);
  }
});
test.afterAll(async () => {
  for (const server of parents)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  parents.length = 0;
});

for (const scheme of ["light", "dark"] as const)
  test.describe(`booking entry — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("exports a decodable selection QR and limits the public widget to approved sites without account data", async ({
      page,
      browser,
    }, info) => {
      test.setTimeout(90000);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      const visitor = await browser.newContext({
        baseURL: fixture.baseURL,
        colorScheme: scheme,
        reducedMotion: "reduce",
        viewport: page.viewportSize(),
      });
      const parent = await visitor.newPage();
      const denied = await visitor.newPage();
      try {
        await signInThroughUi(page, fixture.ownerEmail, "/admin/reputation?tab=entry");
        await page.getByRole("checkbox", { name: "Haircut", exact: true }).check();
        await page
          .getByLabel("Professional (optional)", { exact: true })
          .selectOption({ label: "Stylist A" });
        const link = await page.getByLabel("Booking link", { exact: true }).inputValue();
        expect(new URL(link).searchParams.get("services")).toBe(fixture.haircut);
        const staffId = new URL(link).searchParams.get("staff");
        expect(staffId).toBeTruthy();
        if (!staffId) throw new Error("Missing selected professional");
        const image = page.getByAltText("Booking QR code", { exact: true });
        await expect(image).toBeVisible();
        const raster = await image.evaluate(async (node: HTMLImageElement) => {
          await node.decode();
          const canvas = document.createElement("canvas");
          canvas.width = node.naturalWidth;
          canvas.height = node.naturalHeight;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas unavailable");
          context.drawImage(node, 0, 0);
          return {
            width: canvas.width,
            height: canvas.height,
            data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
          };
        });
        expect(raster.width).toBe(512);
        expect(raster.data.slice(0, 4)).toEqual([255, 255, 255, 255]);
        expect(jsQR(new Uint8ClampedArray(raster.data), raster.width, raster.height)?.data).toBe(
          link,
        );
        const downloadEvent = page.waitForEvent("download");
        await page.getByRole("link", { name: "Download QR PNG", exact: true }).click();
        const download = await downloadEvent;
        const pngPath = `/tmp/sob-booking-qr-${scheme}-${info.project.name}.png`;
        await download.saveAs(pngPath);
        const png = await readFile(pngPath);
        expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(png).toEqual(
          Buffer.from((await image.getAttribute("src"))?.split(",")[1] ?? "", "base64"),
        );
        await page.getByRole("button", { name: "Copy booking link", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
        await page.getByRole("button", { name: "Copy embed code", exact: true }).click();
        const snippet = await page.getByLabel("Embed code", { exact: true }).inputValue();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);
        const widgetUrl = await page.evaluate((html) => {
          const template = document.createElement("template");
          template.innerHTML = html;
          return template.content.querySelector("iframe")?.src ?? "";
        }, snippet);
        expect(new URL(widgetUrl).pathname).toBe("/widget");
        const privateProbe = await page.request.get(widgetUrl);
        expect(privateProbe.ok()).toBe(true);
        const html = await privateProbe.text();
        expect(html).not.toContain(fixture.ownerEmail);
        expect(html).not.toContain("Fixture owner");
        expect(privateProbe.headers()["content-security-policy"]).toContain(
          "frame-ancestors 'self' http://localhost:4274 http://127.0.0.1:4274",
        );
        expect(privateProbe.headers()["x-frame-options"]).toBeUndefined();
        expect((await page.request.get("/book")).headers()["x-frame-options"]).toBe("DENY");
        expect((await page.request.get("/account")).headers()["x-frame-options"]).toBe("DENY");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `booking link composer ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-booking-entry-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
        await parent.goto(`http://127.0.0.1:4274/?src=${encodeURIComponent(widgetUrl)}`);
        const widget = parent.frameLocator('iframe[title="Fixture booking widget"]');
        await expect(
          widget.getByRole("heading", { name: "Book at Sisters of Beauty", exact: true }),
        ).toBeVisible();
        await expect(widget.getByRole("checkbox", { name: "Haircut", exact: true })).toBeChecked();
        await expect(widget.getByLabel("Professional (optional)", { exact: true })).toHaveValue(
          staffId,
        );
        await expect(
          widget.getByRole("link", { name: "My appointments", exact: true }),
        ).toHaveCount(0);
        const popupEvent = visitor.waitForEvent("page");
        await widget
          .getByRole("link", { name: "Continue to booking · opens new tab", exact: true })
          .click();
        const popup = await popupEvent;
        await popup.waitForURL(
          (url) => url.origin === fixture.baseURL && url.pathname.startsWith("/book"),
        );
        expect(new URL(popup.url()).searchParams.get("services")).toBe(fixture.haircut);
        expect(new URL(popup.url()).searchParams.get("staff")).toBe(staffId);
        expect(await popup.evaluate(() => window.opener === null)).toBe(true);
        await popup.close();
        await widget.getByLabel("Widget language", { exact: true }).selectOption("es-AR");
        await expect(
          widget.getByRole("heading", { name: "Reserva en Sisters of Beauty", exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(parent);
        await expectNoSeriousA11yViolations(parent, `Spanish embedded public widget ${scheme}`);
        await parent.screenshot({
          path: `/tmp/sob-booking-widget-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });
        const violations: string[] = [];
        denied.on("console", (message) => {
          if (message.text().includes("frame-ancestors")) violations.push(message.text());
        });
        await denied.goto(`http://127.0.0.1:4275/?src=${encodeURIComponent(widgetUrl)}`);
        await expect.poll(() => violations.length).toBeGreaterThan(0);
        if (process.env.E2E_WEB_IMAGE === "true") {
          await expect
            .poll(async () =>
              (
                await exec("docker", [
                  "inspect",
                  "sob-citame-web-e2e",
                  "--format",
                  "{{.State.Health.Status}}",
                ])
              ).stdout.trim(),
            )
            .toBe("healthy");
        }
        await expect(
          denied
            .frameLocator('iframe[title="Fixture booking widget"]')
            .getByRole("heading", { name: "Book at Sisters of Beauty", exact: true }),
        ).toHaveCount(0);
      } finally {
        await visitor.close();
      }
    });
  });
