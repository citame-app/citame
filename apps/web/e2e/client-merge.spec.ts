import { expect, request, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { at, expectNoHorizontalScroll, nextWeekday, STYLIST_A } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi, switchLocale } from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`client identity links — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews original history, rejects stale contacts and recovers an uncertain merge without changing its packet", async ({
      page,
    }, info) => {
      test.setTimeout(150000);
      const owner = await request.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const token = crypto.randomUUID().slice(0, 8);
      const name = `Source_${token}_${"W".repeat(95)}`;
      const targetName = `Survivor ${token}`;
      const originalNote = `Private source history ${token}`;
      let visit: { id: string; version: number } | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const phone = `+34000${Date.now().toString().slice(-7)}`;
        const csv = `name,email,phone,notes,tags\n${name},source-${token}@example.invalid,${phone},${originalNote},source\n${targetName},survivor-${token}@example.invalid,,Surviving contact note,target\n`;
        const preview = await owner.post("/api/admin/clients/import/preview", { data: { csv } });
        expect(preview.status(), await preview.text()).toBe(200);
        const imported = await owner.post("/api/admin/clients/import", {
          data: {
            csv,
            rows: [2, 3],
            reviewHash: (await preview.json()).reviewHash,
            idempotencyKey: crypto.randomUUID(),
          },
        });
        expect(imported.status(), await imported.text()).toBe(201);
        const [sourceId, targetId] = (await imported.json()).clientIds as string[];
        if (!sourceId || !targetId) throw new Error("Missing identity fixtures");
        expect(
          (await owner.patch(`/api/admin/clients/${targetId}`, { data: { phone } })).status(),
        ).toBe(200);
        for (let ahead = 22; ahead < 40; ahead++) {
          const response = await owner.post("/api/appointments", {
            data: {
              clientId: sourceId,
              staffId: STYLIST_A,
              serviceIds: [fixture.haircut],
              startsAt: at(nextWeekday(ahead), "11:00"),
            },
          });
          if (response.status() === 201) {
            visit = await response.json();
            break;
          }
          expect([409, 422]).toContain(response.status());
        }
        if (!visit) throw new Error("No verified source appointment");
        const controls = await owner.get(`/api/admin/clients/${sourceId}/controls`);
        expect(
          (
            await owner.patch(`/api/admin/clients/${sourceId}/controls`, {
              data: {
                version: (await controls.json()).version,
                bookingAccess: "blocked",
                reason: "Synthetic identity review",
                tags: ["source"],
              },
            })
          ).status(),
        ).toBe(200);
        await signInThroughUi(page, fixture.ownerEmail, `/admin/clients/${targetId}`);
        await page.getByRole("button", { name: "Review duplicate profiles", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Duplicate client profiles", exact: true });
        await dialog.getByRole("radio", { name: new RegExp(`Source_${token}`) }).check();
        await dialog.getByRole("button", { name: "Review identity link", exact: true }).click();
        const consent = dialog.getByRole("checkbox", { name: /I have verified/ });
        await expect(consent).toBeVisible();
        await expect(dialog.getByText(originalNote, { exact: true })).toBeVisible();
        await expect(dialog.getByText("Bookings blocked", { exact: false })).toBeVisible();
        const submit = dialog.getByRole("button", { name: "Join these profiles", exact: true });
        await expect(submit).toBeDisabled();
        expect(
          (
            await owner.patch(`/api/admin/clients/${targetId}`, { data: { phone: `${phone}1` } })
          ).status(),
        ).toBe(200);
        await consent.check();
        await submit.click();
        await expect(
          dialog.getByText("The profiles changed. Review them again before confirming.", {
            exact: true,
          }),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "Review identity link", exact: true }).click();
        await expect(consent).not.toBeChecked();
        await consent.check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Identity review ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-client-merge-${scheme}-${info.project.name}.png`,
          animations: "disabled",
        });
        const attempts: unknown[] = [];
        await page.route("**/api/admin/clients/merge", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON());
          if (attempts.length === 1) {
            const response = await route.fetch();
            expect(response.status(), await response.text()).toBe(201);
            return route.abort("connectionreset");
          }
          if (attempts.length === 2)
            return route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({
                error: { code: "unauthorized", message: "Synthetic expired response" },
              }),
            });
          return route.continue();
        });
        await submit.click();
        await expect(
          dialog.getByText(
            "The result is uncertain. Recover this same request before starting another merge.",
            { exact: true },
          ),
        ).toBeVisible();
        await expect(dialog.getByLabel("Search another profile", { exact: true })).toBeDisabled();
        await expect(consent).toBeDisabled();
        const retry = dialog.getByRole("button", { name: "Recover this merge", exact: true });
        await retry.click();
        await expect.poll(() => attempts.length).toBe(2);
        await expect(
          dialog.getByRole("link", { name: "Sign in again in another tab", exact: true }),
        ).toHaveAttribute("target", "_blank");
        await expect(retry).toBeEnabled();
        await retry.click();
        await expect(
          dialog.getByText(
            "Profiles joined. Original history and financial records are preserved.",
            { exact: true },
          ),
        ).toBeVisible();
        expect(attempts).toHaveLength(3);
        expect(attempts[1]).toEqual(attempts[0]);
        expect(attempts[2]).toEqual(attempts[0]);
        await dialog.getByRole("link", { name: "Open surviving profile", exact: true }).click();
        await expect(page.getByRole("heading", { name: targetName, exact: true })).toBeVisible();
        await page.getByText("Original profile history", { exact: true }).click();
        await expect(page.getByText(originalNote, { exact: true })).toBeVisible();
        const original = await owner.get(`/api/admin/clients/${sourceId}`);
        expect(await original.json()).toMatchObject({
          identity: { rootId: targetId },
          appointments: expect.arrayContaining([
            expect.objectContaining({ id: visit.id, clientId: sourceId }),
          ]),
        });
        await page.goto(`/admin/clients/${sourceId}`);
        await expect(
          page.getByRole("link", { name: "Open surviving profile", exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel("Full name", { exact: true })).toBeDisabled();
        await switchLocale(page, "Español");
        await expect(
          page.getByRole("link", { name: "Abrir ficha conservada", exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Historical identity Spanish ${scheme}`);
      } finally {
        if (visit) {
          await owner.patch(`/api/appointments/${visit.id}`, {
            data: { version: visit.version, status: "cancelled" },
          });
        }
        await owner.dispose();
      }
    });
  });
