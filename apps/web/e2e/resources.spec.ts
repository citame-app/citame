import { expect, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { at, expectNoHorizontalScroll, nextWeekday, STYLIST_A, STYLIST_B } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi, switchLocale } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`shared resource capacity — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("configures room requirements and rejects a capacity reduction that would overbook existing visits", async ({
      page,
    }) => {
      const bookings: { id: string; version: number }[] = [];
      let resourceId: string | undefined;
      await signInThroughUi(page, fixture.ownerEmail, "/admin/services");
      await page.getByRole("button", { name: "Resources", exact: true }).click();
      await expect(page).toHaveURL(/\/admin\/services$/);
      const catalog = await (await page.request.get("/api/admin/services")).json();
      const haircut = catalog.services.find((s: { id: string }) => s.id === fixture.haircut);
      const assignment = await page.request.put(`/api/admin/services/${fixture.haircut}/staff`, {
        data: { staffIds: [...new Set([...haircut.staffIds, STYLIST_A, STYLIST_B])] },
      });
      expect(assignment.status(), await assignment.text()).toBe(200);
      const name = `Treatment room ${crypto.randomUUID().slice(0, 8)}`;
      try {
        await page.getByRole("button", { name: "Rooms & equipment", exact: true }).click();
        const panel = page.getByRole("dialog", { name: "Rooms & equipment", exact: true });
        await panel.getByRole("button", { name: "New resource", exact: true }).click();
        await panel.getByLabel("Resource name", { exact: true }).fill(name);
        await panel.getByLabel("Available units", { exact: true }).fill("1");
        const created = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/resources") && r.request().method() === "POST",
        );
        await panel.getByRole("button", { name: "Save resource", exact: true }).click();
        const resource = await (await created).json();
        resourceId = resource.id;
        await expect(panel.getByText("Resource saved", { exact: true })).toBeVisible();
        await panel.getByRole("button", { name: "Back to resources", exact: true }).click();
        await panel.getByLabel("Service resources", { exact: true }).selectOption(fixture.haircut);
        await panel.getByLabel(`Units of ${name}`, { exact: true }).fill("1");
        await panel.getByRole("button", { name: "Save requirements", exact: true }).click();
        await expect(panel.getByText("Requirements saved", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `resource requirements ${scheme}`);
        const startsAt = at(nextWeekday(5, [1]), "11:00");
        const book = (staffId: string) =>
          page.request.post("/api/appointments", {
            data: {
              staffId,
              serviceIds: [fixture.haircut],
              startsAt,
              client: { name: "Resource browser client" },
            },
          });
        const attempts = await Promise.all([book(STYLIST_A), book(STYLIST_B)]);
        for (const r of attempts) if (r.status() === 201) bookings.push(await r.json());
        expect(
          attempts.map((r) => r.status()).sort(),
          (await Promise.all(attempts.map((r) => r.text()))).join("; "),
        ).toEqual([201, 409]);
        const first = attempts.find((r) => r.status() === 201);
        if (!first) throw new Error("No booked visit");
        const booking = await first.json();
        const secondStaff = booking.staffId === STYLIST_A ? STYLIST_B : STYLIST_A;
        const calendar = await (
          await page.request.get(
            `/api/appointments/calendar?from=${at(nextWeekday(5, [1]), "00:00")}&to=${at(nextWeekday(6, [2]), "00:00")}`,
          )
        ).json();
        expect(
          calendar.appointments.find((a: { id: string }) => a.id === booking.id)?.resources,
        ).toEqual([{ resourceId, name, quantity: 1 }]);
        await panel.getByRole("button", { name: `Edit ${name}`, exact: true }).click();
        await panel.getByLabel("Available units", { exact: true }).fill("2");
        await panel.getByRole("button", { name: "Save resource", exact: true }).click();
        await expect(panel.getByText("Resource saved", { exact: true })).toBeVisible();
        const second = await book(secondStaff);
        expect(second.status(), await second.text()).toBe(201);
        bookings.push(await second.json());
        await panel.getByLabel("Available units", { exact: true }).fill("1");
        await panel.getByRole("button", { name: "Save resource", exact: true }).click();
        await expect(
          panel.getByRole("button", { name: "Reload current settings", exact: true }),
        ).toBeVisible();
        await expect(panel.getByLabel("Available units", { exact: true })).toHaveValue("1");
        const current = (
          await (await page.request.get("/api/admin/resources")).json()
        ).resources.find((r: { id: string }) => r.id === resourceId);
        expect(current.capacity).toBe(2);
        const cancelled = bookings.pop();
        if (!cancelled) throw new Error("Missing cancellation target");
        const result = await page.request.patch(`/api/appointments/${cancelled.id}`, {
          data: { version: cancelled.version, status: "cancelled" },
        });
        expect(result.status(), await result.text()).toBe(200);
        await panel.getByRole("button", { name: "Save resource", exact: true }).click();
        await expect(panel.getByText("Resource saved", { exact: true })).toBeVisible();
        await expect(
          panel.getByRole("button", { name: "Reload current settings", exact: true }),
        ).toHaveCount(0);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `resource editor ${scheme}`);
        await panel.getByRole("button", { name: "Close panel", exact: true }).click();
        await switchLocale(page, "Español");
        await page.getByRole("button", { name: "Cabinas y equipos", exact: true }).click();
        const spanish = page.getByRole("dialog", { name: "Cabinas y equipos", exact: true });
        await spanish
          .getByLabel("Recursos por servicio", { exact: true })
          .selectOption(fixture.haircut);
        await expect(spanish.getByLabel(`Unidades de ${name}`, { exact: true })).toHaveValue("1");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `resource Spanish ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-resources-es-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        const date = nextWeekday(5, [1]);
        await page.goto(`/admin/calendar?date=${date}&view=list`);
        const filters = page.getByRole("button", { name: "Filtros de agenda" });
        if (await filters.isVisible()) await filters.click();
        const bookedResource = page.getByLabel("Recurso reservado", { exact: true });
        await bookedResource.selectOption({ label: name });
        await expect(bookedResource).toHaveValue(resourceId ?? "");
        await expect(page.getByRole("button", { name: /Resource browser client/ })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `calendar resource filter ${scheme}`);
      } finally {
        for (const booking of bookings)
          await page.request.patch(`/api/appointments/${booking.id}`, {
            data: { version: booking.version, status: "cancelled" },
          });
        if (resourceId) {
          const requirements = await (
            await page.request.get(`/api/admin/services/${fixture.haircut}/resources`)
          ).json();
          await page.request.put(`/api/admin/services/${fixture.haircut}/resources`, {
            data: { version: requirements.version, requirements: [] },
          });
          const resource = (
            await (await page.request.get("/api/admin/resources")).json()
          ).resources.find((r: { id: string }) => r.id === resourceId);
          if (resource)
            await page.request.put(`/api/admin/resources/${resourceId}`, {
              data: {
                name: resource.name,
                kind: resource.kind,
                capacity: resource.capacity,
                version: resource.version,
                active: false,
              },
            });
        }
      }
    });
  });
}
