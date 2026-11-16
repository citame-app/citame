import { expect, test } from "@playwright/test";
import {
  asOwner,
  at,
  expectNoHorizontalScroll,
  HAIRCUT,
  nextWeekday,
  OWNER_EMAIL,
  STYLIST_A,
  signInAs,
} from "./admin-helpers";
import { expectNoSeriousA11yViolations } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`client controls — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("saves searchable labels, blocks bookings and preserves contact drafts", async ({
      page,
    }) => {
      const owner = await asOwner();
      const name = `CRM fixture ${crypto.randomUUID()}`;
      const tag = `crm-${crypto.randomUUID().slice(0, 8)}`;
      let booking: { id: string; version: number; clientId: string } | null = null;
      let startsAt = "";
      try {
        for (let day = 40; day < 55; day++) {
          startsAt = at(nextWeekday(day), "15:00");
          const response = await owner.post("/api/appointments", {
            data: {
              staffId: STYLIST_A,
              serviceIds: [HAIRCUT],
              startsAt,
              client: { name },
              override: true,
            },
          });
          if (response.status() === 409) continue;
          expect(response.status(), await response.text()).toBe(201);
          booking = await response.json();
          break;
        }
        if (!booking) throw new Error("No client fixture slot");
        const cancelled = await owner.patch(`/api/appointments/${booking.id}`, {
          data: { version: booking.version, status: "cancelled" },
        });
        expect(cancelled.ok(), await cancelled.text()).toBe(true);
        await signInAs(page, OWNER_EMAIL, `/admin/clients/${booking.clientId}`);
        const controls = page.getByRole("region", {
          name: "Client tags & booking access",
          exact: true,
        });
        await controls.getByLabel("Client tags", { exact: true }).fill(tag);
        await page.getByLabel("Full name", { exact: true }).fill("Unsaved contact draft");
        await controls.getByLabel("Booking access", { exact: true }).selectOption("blocked");
        await expect(
          controls.getByRole("button", { name: "Save client controls", exact: true }),
        ).toBeDisabled();
        await controls
          .getByLabel("Access change reason", { exact: true })
          .fill("Local fixture requires review");
        await controls.getByRole("button", { name: "Save client controls", exact: true }).click();
        await expect(controls.getByText("Client controls saved", { exact: true })).toBeVisible();
        await expect(page.getByLabel("Full name", { exact: true })).toHaveValue(
          "Unsaved contact draft",
        );
        const blocked = await owner.post("/api/appointments", {
          data: {
            staffId: STYLIST_A,
            serviceIds: [HAIRCUT],
            startsAt,
            clientId: booking.clientId,
            override: true,
          },
        });
        expect(blocked.status()).toBe(403);
        expect(await blocked.text()).not.toContain("requires review");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `blocked profile ${scheme}`);
        await page.getByLabel("Full name", { exact: true }).fill(name);
        await page.goto("/admin/clients");
        const filtered = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return url.pathname === "/api/admin/clients" && url.searchParams.get("search") === tag;
        });
        await page.getByLabel("Search clients", { exact: true }).fill(tag);
        expect((await (await filtered).json()).total).toBe(1);
        await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        await page.goto(`/admin/clients/${booking.clientId}`);
        await controls.getByLabel("Booking access", { exact: true }).selectOption("trusted");
        await controls
          .getByLabel("Access change reason", { exact: true })
          .fill("Profile reviewed in local test");
        await controls.getByRole("button", { name: "Save client controls", exact: true }).click();
        await expect(controls.getByText("Client controls saved", { exact: true })).toBeVisible();
        await expect(controls.getByLabel("Booking access", { exact: true })).toHaveValue("trusted");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `trusted profile ${scheme}`);
      } finally {
        if (booking) {
          const response = await owner.get(`/api/admin/clients/${booking.clientId}/controls`);
          if (response.ok()) {
            const row = await response.json();
            await owner.patch(`/api/admin/clients/${booking.clientId}/controls`, {
              data: {
                version: row.version,
                tags: [],
                bookingAccess: "normal",
                reason: "Restore local fixture",
              },
            });
          }
        }
        await owner.dispose();
      }
    });
  });
}
