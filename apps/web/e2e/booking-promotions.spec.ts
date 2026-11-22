import { readFile } from "node:fs/promises";
import { expect, request as playwrightRequest, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import {
  expectNoSeriousA11yViolations,
  pickFirstTime,
  pickProfessional,
  signInThroughUi,
  switchLocale,
} from "./helpers";

for (const scheme of ["light", "dark"] as const)
  test.describe(`booking offers — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews discounted deposits, rejects changed offers and recovers the same booking through an uncertain and then unauthorized response", async ({
      page,
    }, info) => {
      test.setTimeout(150000);
      const owner = await playwrightRequest.newContext({
        baseURL: fixture.baseURL,
        extraHTTPHeaders: { origin: fixture.baseURL },
      });
      const code = `BOOK_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
      const terms = {
        code,
        name: `Offer_${scheme}_${info.project.name}_${"W".repeat(65)}`,
        kind: "percent",
        value: 2000,
        eligibleKinds: ["service"],
        timing: {
          weekdays: [1, 2, 3, 4, 5, 6, 7],
          startMinute: 0,
          endMinute: 1440,
          lastMinuteHours: 168,
        },
      };
      let serviceId = "";
      let forecastVisit: { id: string; version: number } | undefined;
      let visit:
        | {
            id: string;
            version: number;
            startsAt: string;
            protection: { checkoutId: string; depositCents: number; policyVersion: number };
          }
        | undefined;
      try {
        expect(
          (
            await owner.post("/api/auth/sign-in/email", {
              data: { email: fixture.ownerEmail, password: fixture.password },
            })
          ).ok(),
        ).toBe(true);
        const staff = (await (await owner.get("/api/staff")).json()).staff.find(
          (row: { displayName: string }) => row.displayName === "Stylist A",
        );
        const created = await owner.post("/api/admin/services", {
          data: {
            name: `Fixture offer treatment ${code}`,
            durationMinutes: 45,
            bufferMinutes: 0,
            priceCents: 10000,
            currency: "EUR",
            staffIds: [staff.id],
          },
        });
        expect(created.status(), await created.text()).toBe(201);
        serviceId = (await created.json()).id;
        const policy = await (await owner.get("/api/admin/settings/booking-policy")).json();
        const savedPolicy = await owner.put("/api/admin/settings/booking-policy", {
          data: { ...policy, enabled: true, depositKind: "percent", depositValue: 2500 },
        });
        expect(savedPolicy.status()).toBe(200);
        const policyVersion = (await savedPolicy.json()).version;
        const promo = await owner.post("/api/admin/rewards/promotions", { data: terms });
        expect(promo.status()).toBe(201);
        const promotion = await promo.json();
        await signInThroughUi(page, fixture.clientEmail, `/book?services=${serviceId}`);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await pickProfessional(page, "Stylist A");
        await pickFirstTime(page);
        await page.getByRole("button", { name: "Continue", exact: true }).click();
        await page.getByLabel("Promotion code (optional)", { exact: true }).fill(code);
        await expect(
          page.getByRole("button", { name: "Confirm booking", exact: true }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Review offer", exact: true }).click();
        await expect(page.getByText("Save €20 · Booking total €80", { exact: true })).toBeVisible();
        const consent = page.getByRole("region", {
          name: "Booking deposits & cancellation",
          exact: true,
        });
        await expect(consent).toContainText("Pay a deposit of €20");
        await page
          .getByLabel("I accept this deposit and cancellation policy.", { exact: true })
          .check();
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promotion.id}`, {
              data: { ...terms, value: 2500, version: promotion.version },
            })
          ).status(),
        ).toBe(200);
        let attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const rejected = await attempt;
        expect(rejected.status()).toBe(409);
        expect((await rejected.json()).error.code).toBe("booking_promotion_changed");
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toHaveValue(
          code,
        );
        await expect(
          page.getByRole("button", { name: "Confirm booking", exact: true }),
        ).toBeDisabled();
        await page.getByRole("button", { name: "Review offer", exact: true }).click();
        await expect(page.getByText("Save €25 · Booking total €75", { exact: true })).toBeVisible();
        await expect(consent).toContainText("Pay a deposit of €18.75");
        await expect(
          page.getByLabel("I accept this deposit and cancellation policy.", { exact: true }),
        ).not.toBeChecked();
        await page
          .getByLabel("I accept this deposit and cancellation policy.", { exact: true })
          .check();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `reviewed booking offer ${scheme}`);
        let writes = 0;
        await page.route("**/api/appointments", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes++;
          if (writes === 1) {
            const result = await route.fetch();
            expect(result.status(), await result.text()).toBe(201);
            visit = await result.json();
            return route.abort("connectionreset");
          }
          if (writes === 2)
            return route.fulfill({
              status: 401,
              contentType: "application/json",
              body: JSON.stringify({
                error: {
                  code: "unauthorized",
                  message: "Fixture session expired after the original request",
                },
              }),
            });
          return route.continue();
        });
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const uncertain = page.getByText(
          "The booking response is uncertain. Retry the same booking to recover its result before editing or making another reservation.",
          { exact: true },
        );
        await expect(uncertain).toBeVisible();
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toBeDisabled();
        await page.getByRole("link", { name: "Services", exact: true }).click();
        const guard = page.getByRole("dialog", {
          name: "Resolve this booking request",
          exact: true,
        });
        await expect(guard).toBeVisible();
        await guard.getByRole("button", { name: "Stay and recover", exact: true }).click();
        await expect(guard).toHaveCount(0);
        attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        expect((await attempt).status()).toBe(401);
        // A later 401 cannot prove that the first request did not commit.
        await expect(page.getByLabel("Promotion code (optional)", { exact: true })).toBeDisabled();
        await expect(uncertain).toBeVisible();
        expect(
          (
            await owner.put(`/api/admin/rewards/promotions/${promotion.id}`, {
              data: { ...terms, value: 2500, active: false, version: promotion.version + 1 },
            })
          ).status(),
        ).toBe(200);
        attempt = page.waitForResponse(
          (r) => r.url().endsWith("/api/appointments") && r.request().method() === "POST",
        );
        await page.getByRole("button", { name: "Confirm booking", exact: true }).click();
        const recovered = await attempt;
        expect(recovered.status(), await recovered.text()).toBe(201);
        expect(recovered.headers()["x-idempotent-replay"]).toBe("true");
        if (!visit) throw new Error("Missing original booking");
        expect((await recovered.json()).id).toBe(visit.id);
        await expect(page).toHaveURL(new RegExp(`/book/confirmed/${visit.id}$`));
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(page.getByText("€75", { exact: true })).toBeVisible();
        const bill = await (
          await owner.get(`/api/admin/commerce/checkouts/${visit.protection.checkoutId}`)
        ).json();
        expect(bill).toMatchObject({
          totalCents: 7500,
          discountCents: 2500,
          protection: { depositCents: 1875, policyVersion },
          reward: { code, appointmentTiming: { timing: { lastMinuteHours: 168 } } },
        });
        await switchLocale(page, "Español");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `confirmed discounted deposit ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-booking-promotion-${scheme}-${info.project.name}.png`,
          fullPage: true,
        });

        const paid = await owner.post(
          `/api/admin/commerce/checkouts/${visit.protection.checkoutId}/payments`,
          {
            data: {
              method: "external_card",
              amountCents: 1875,
              idempotencyKey: crypto.randomUUID(),
            },
          },
        );
        expect(paid.status(), await paid.text()).toBe(201);
        const { payment } = (await paid.json()) as { payment: { id: string } };
        const receiptAfterPayment = await owner.get(
          `/api/admin/commerce/checkouts/${visit.protection.checkoutId}`,
        );
        expect(receiptAfterPayment.ok()).toBe(true);
        const { payments } = (await receiptAfterPayment.json()) as {
          payments: { id: string; createdAt: string; updatedAt?: string }[];
        };
        const recordedPayment = payments.find(({ id }) => id === payment.id);
        if (!recordedPayment) throw new Error("Missing recorded payment");
        // Confirming a protected deposit advances the appointment's concurrency version.
        const currentVisit = await owner.get(`/api/appointments/${visit.id}/context`);
        expect(currentVisit.ok()).toBe(true);
        visit.version = (await currentVisit.json()).appointmentVersion;
        const cancelled = await owner.patch(`/api/appointments/${visit.id}`, {
          data: { version: visit.version, status: "cancelled" },
        });
        expect(cancelled.status(), await cancelled.text()).toBe(200);
        const day = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Argentina/Buenos_Aires",
        }).format(new Date(visit.startsAt));
        const freedStart = visit.startsAt;
        visit = undefined;
        await page.context().clearCookies();
        const reportPath = `/admin/reports?preset=custom&from=${day}&to=${day}&staff=${staff.id}`;
        await signInThroughUi(page, fixture.ownerEmail, reportPath);
        const breakdown = page.getByRole("region", { name: "Appointment breakdown" });
        await breakdown.getByRole("combobox", { name: "Group by" }).selectOption("promotion");
        const offerLabel = `${terms.name} (${code})`;
        await expect(
          breakdown.getByText(offerLabel, { exact: true }).filter({ visible: true }),
        ).toBeVisible();
        const reportRow =
          info.project.name === "mobile"
            ? breakdown
                .getByRole("listitem")
                .filter({ hasText: offerLabel })
                .getByRole("definition")
            : breakdown
                .getByRole("row")
                .filter({ hasText: offerLabel })
                .getByRole("cell")
                .filter({ hasNotText: offerLabel });
        await expect(reportRow).toHaveText(["1", "0", "0", "1", "0"]);
        const download = page.waitForEvent("download", { timeout: 10000 });
        await page.getByRole("button", { name: "Export CSV" }).click();
        const csvPath = await (await download).path();
        expect(await readFile(csvPath, "utf8")).toContain(`promotion,${offerLabel},1,0,0,1,0\r\n`);
        await expectNoHorizontalScroll(page);
        await breakdown.screenshot({ path: info.outputPath("booking-promotion-report-en.png") });
        await page
          .context()
          .addCookies([{ name: "sob_locale", value: "es-AR", url: fixture.baseURL }]);
        await page.reload();
        const localized = page.getByRole("region", { name: "Desglose de citas" });
        await localized.getByRole("combobox", { name: "Agrupar por" }).selectOption("promotion");
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `booking promotion report ${scheme}`);
        await localized.screenshot({ path: info.outputPath("booking-promotion-report-es.png") });

        const paymentDate = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "America/Argentina/Buenos_Aires",
        }).format(new Date(recordedPayment.updatedAt ?? recordedPayment.createdAt));
        const itemName = `Office_${code}_${"W".repeat(56)}`;
        const itemReceipt = await owner.post("/api/admin/commerce/checkouts", {
          data: {
            staffId: staff.id,
            lines: [{ kind: "custom", description: itemName, quantity: 2, unitAmountCents: 1234 }],
            idempotencyKey: crypto.randomUUID(),
          },
        });
        expect(itemReceipt.status()).toBe(201);
        const itemSale = await itemReceipt.json();
        expect(
          (
            await owner.post(`/api/admin/commerce/checkouts/${itemSale.id}/payments`, {
              data: {
                method: "external_card",
                amountCents: 2468,
                idempotencyKey: crypto.randomUUID(),
              },
            })
          ).status(),
        ).toBe(201);
        await page.getByRole("button", { name: "Informes económicos", exact: true }).click();
        const financial = page.getByRole("region", { name: "Ventas y cobros", exact: true });
        await financial.getByLabel("Desde", { exact: true }).fill(paymentDate);
        await financial.getByLabel("Hasta", { exact: true }).fill(paymentDate);
        await financial.getByRole("combobox", { name: "Profesional" }).selectOption(staff.id);
        await financial.getByRole("button", { name: "Aplicar filtros", exact: true }).click();
        const mobile = info.project.name === "mobile";
        const collections = financial.getByRole(mobile ? "list" : "table", {
          name: "Cobros por promoción de reserva",
        });
        const collectedRow = collections.getByRole(mobile ? "listitem" : "row").filter({
          hasText: offerLabel,
        });
        const amounts = collectedRow.getByRole(mobile ? "definition" : "cell");
        await expect(amounts).toHaveCount(3);
        await expect(amounts.first()).toContainText("18,75");
        const items = financial.getByRole(mobile ? "list" : "table", {
          name: "Ventas liquidadas por artículo y plan",
        });
        const itemRow = items.getByRole(mobile ? "listitem" : "row").filter({ hasText: itemName });
        const itemAmounts = itemRow.getByRole(mobile ? "definition" : "cell");
        await expect(itemAmounts).toHaveCount(3);
        await expect(itemAmounts.nth(0)).toHaveText("2");
        await expect(itemAmounts.nth(1)).toContainText("24,68");
        await items.screenshot({ path: info.outputPath("settled-sales-items-es.png") });
        const financialDownload = page.waitForEvent("download", { timeout: 10000 });
        await financial.getByRole("button", { name: "Exportar resumen económico (CSV)" }).click();
        const financialCsv = await readFile(await (await financialDownload).path(), "utf8");
        expect(financialCsv).toContain(`"${terms.name}","${code}","1875","0","1875","EUR"`);
        expect(financialCsv).toContain(`"custom","","${itemName}","2","2468","0","EUR"`);
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `booking promotion collections ${scheme}`);
        await collections.screenshot({ path: info.outputPath("promotion-collections-es.png") });
        const baselineResponse = await owner.get(
          `/api/admin/accounting/sales?from=${day}&to=${day}&staffId=${staff.id}`,
        );
        expect(baselineResponse.ok()).toBe(true);
        const baseline = (await baselineResponse.json()).revenueForecast.rows.find(
          (row: { currency: string | null }) => row.currency === "EUR",
        );
        const clientId = crypto.randomUUID();
        const forecastClient = await owner.post("/api/admin/clients", {
          data: { id: clientId, name: `Forecast fixture ${code}` },
        });
        expect(forecastClient.status(), await forecastClient.text()).toBe(201);
        const currentPolicy = await (await owner.get("/api/admin/settings/booking-policy")).json();
        const disabledPolicy = await owner.put("/api/admin/settings/booking-policy", {
          data: { ...currentPolicy, enabled: false },
        });
        expect(disabledPolicy.status(), await disabledPolicy.text()).toBe(200);
        const bookedForForecast = await owner.post("/api/appointments", {
          data: {
            staffId: staff.id,
            clientId,
            serviceIds: [serviceId],
            startsAt: freedStart,
            override: true,
          },
        });
        expect(bookedForForecast.status(), await bookedForForecast.text()).toBe(201);
        forecastVisit = await bookedForForecast.json();
        await financial.getByRole("button", { name: "Próximos 30 días" }).click();
        const forecast = financial.getByRole(mobile ? "list" : "table", {
          name: "Previsión de ingresos de la agenda",
        });
        await expect(
          forecast
            .getByRole(mobile ? "listitem" : "row")
            .filter({ hasText: /EUR/ })
            .first(),
        ).toBeVisible();
        await forecast.screenshot({ path: info.outputPath("revenue-forecast-es.png") });
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `booking revenue forecast ${scheme}`);
        const forecastRange = new URL(page.url()).searchParams;
        expect(forecastRange.get("staff")).toBe(staff.id);
        expect(forecastRange.get("section")).toBe("financial");
        expect(
          Date.parse(forecastRange.get("to") ?? "") - Date.parse(forecastRange.get("from") ?? ""),
        ).toBe(29 * 86_400_000);
        const forecastDownload = page.waitForEvent("download", { timeout: 10000 });
        await financial.getByRole("button", { name: "Exportar resumen económico (CSV)" }).click();
        expect(await readFile(await (await forecastDownload).path(), "utf8")).toContain(
          `"${day}","EUR","${(baseline?.appointmentLines ?? 0) + 1}","${(baseline?.amountCents ?? 0) + 10000}"`,
        );
        await page.reload();
        await expect(
          forecast
            .getByRole(mobile ? "listitem" : "row")
            .filter({ hasText: /EUR/ })
            .first(),
        ).toBeVisible();
        await switchLocale(page, "English");
        const english = page.getByRole(mobile ? "list" : "table", {
          name: "Collections by booking promotion",
        });
        await expect(english.getByText(offerLabel, { exact: true })).toBeVisible();
        const englishItems = page.getByRole(mobile ? "list" : "table", {
          name: "Settled sales by item and plan",
        });
        await expect(englishItems.getByText(itemName, { exact: false })).toBeVisible();
        await englishItems.screenshot({ path: info.outputPath("settled-sales-items-en.png") });
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `booking promotion collections EN ${scheme}`);
        await english.screenshot({ path: info.outputPath("promotion-collections-en.png") });
        await page.getByRole("button", { name: "Next 30 days" }).click();
        const englishForecast = page.getByRole(mobile ? "list" : "table", {
          name: "Revenue forecast from bookings",
        });
        await expect(
          englishForecast
            .getByRole(mobile ? "listitem" : "row")
            .filter({ hasText: /EUR/ })
            .first(),
        ).toBeVisible();
        await englishForecast.screenshot({ path: info.outputPath("revenue-forecast-en.png") });
        const clientsTab = page
          .getByRole("navigation", { name: "Reports" })
          .getByRole("button", { name: "Clients", exact: true });
        await clientsTab.click();
        await page.getByRole("radio", { name: "Last 7 days", exact: true }).check();
        await expect(clientsTab).toHaveAttribute("aria-pressed", "true");
        expect(new URL(page.url()).searchParams.get("section")).toBe("clients");
        if (!forecastVisit) throw new Error("Missing appointment for margin report");
        const appointmentCheckout = await owner.post("/api/admin/commerce/checkouts", {
          data: { appointmentId: forecastVisit.id, idempotencyKey: crypto.randomUUID() },
        });
        expect(appointmentCheckout.status(), await appointmentCheckout.text()).toBe(201);
        const appointmentReceipt = await appointmentCheckout.json();
        expect(appointmentReceipt.totalCents).toBe(10000);
        expect(
          (
            await owner.post(`/api/admin/commerce/checkouts/${appointmentReceipt.id}/payments`, {
              data: {
                method: "external_card",
                amountCents: 10000,
                idempotencyKey: crypto.randomUUID(),
              },
            })
          ).status(),
        ).toBe(201);
        await page.goto(
          `/admin/reports?client=${clientId}&preset=custom&from=${paymentDate}&to=${paymentDate}`,
        );
        await page.getByRole("button", { name: "Direct margin by appointment" }).click();
        const margins = page.getByRole(mobile ? "list" : "table", {
          name: "Direct margin by appointment",
        });
        await expect(margins.getByText("Costs pending", { exact: true })).toBeVisible();
        await margins.getByRole("button", { name: "Review costs" }).click();
        await page.getByRole("textbox", { name: "Labour (EUR)", exact: true }).fill("20");
        const saveCosts = page.getByRole("button", { name: "Save reviewed costs" });
        await expect(saveCosts).toBeEnabled();
        const marginPath = `/api/admin/accounting/appointment-profitability?from=${paymentDate}&to=${paymentDate}`;
        const { generation } = await (await owner.get(marginPath)).json();
        const costsPath = `/api/admin/accounting/appointment-profitability/${forecastVisit.id}/costs`;
        const concurrentCosts = await owner.put(costsPath, {
          data: { generation, version: null, labourCents: null, materialsCents: 2500 },
        });
        expect(concurrentCosts.status(), await concurrentCosts.text()).toBe(200);
        await saveCosts.click();
        await page.getByRole("button", { name: "Try again", exact: true }).click();
        await page.getByRole("button", { name: "Use the current revision", exact: true }).click();
        await saveCosts.click();
        await expect(margins.getByText("€55", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `appointment margins EN ${scheme}`);
        await margins.screenshot({ path: info.outputPath("appointment-profitability-en.png") });
        const profitDownload = page.waitForEvent("download", { timeout: 10000 });
        await page.getByRole("link", { name: "Export all appointment margins (CSV)" }).click();
        expect(await readFile(await (await profitDownload).path(), "utf8")).toContain(
          '"10000","0","0","0","2000","2500","5500","","EUR"',
        );
        await switchLocale(page, "Español");
        const marginsEs = page.getByRole(mobile ? "list" : "table", {
          name: "Margen directo por cita",
        });
        await expect(marginsEs.getByText(/EUR\s*55/)).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `appointment margins ES ${scheme}`);
        await marginsEs.screenshot({ path: info.outputPath("appointment-profitability-es.png") });

        await page.goto(`/admin/reports?preset=custom&from=${paymentDate}&to=${paymentDate}`);
        const overviewEs = page.getByRole("group", { name: "Resumen", exact: true });
        await expect(overviewEs.getByText("Clientes atendidos", { exact: true })).toBeVisible();
        await expect(
          overviewEs.getByText("Productos con stock bajo", { exact: true }),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `business overview ES ${scheme}`);
        await overviewEs.screenshot({ path: info.outputPath("business-overview-es.png") });
        await switchLocale(page, "English");
        const overviewEn = page.getByRole("group", { name: "Summary", exact: true });
        await expect(overviewEn.getByText("Net collections", { exact: true })).toBeVisible();
        await expect(overviewEn.getByText("Planned occupancy", { exact: true })).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `business overview EN ${scheme}`);
        await overviewEn.screenshot({ path: info.outputPath("business-overview-en.png") });
      } finally {
        if (forecastVisit)
          await owner.patch(`/api/appointments/${forecastVisit.id}`, {
            data: { version: forecastVisit.version, status: "cancelled" },
          });
        if (visit)
          await owner.patch(`/api/appointments/${visit.id}`, {
            data: { version: visit.version, status: "cancelled" },
          });
        const current = await (await owner.get("/api/admin/settings/booking-policy")).json();
        await owner.put("/api/admin/settings/booking-policy", {
          data: { ...current, enabled: false },
        });
        if (serviceId) await owner.delete(`/api/admin/services/${serviceId}`);
        await owner.dispose();
      }
    });
  });

test("publishes a dated service offer on the profile and takes it to a reviewed quote", async ({
  page,
}) => {
  const owner = await playwrightRequest.newContext({
    baseURL: fixture.baseURL,
    extraHTTPHeaders: { origin: fixture.baseURL },
  });
  const code = `FLASH_${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const name = `Flash offer ${code}`;
  let serviceId: string | undefined;
  let promotion: { id: string; version: number } | undefined;
  try {
    const signedIn = await owner.post("/api/auth/sign-in/email", {
      data: { email: fixture.ownerEmail, password: fixture.password },
    });
    expect(signedIn.ok()).toBe(true);
    const staff = (await (await owner.get("/api/staff")).json()).staff.find(
      (row: { displayName: string }) => row.displayName === "Stylist A",
    );
    const service = await owner.post("/api/admin/services", {
      data: {
        name: `Flash_${"W".repeat(55)}_${code}`,
        durationMinutes: 45,
        bufferMinutes: 0,
        priceCents: 10000,
        currency: "EUR",
        staffIds: [staff.id],
      },
    });
    expect(service.status(), await service.text()).toBe(201);
    ({ id: serviceId } = (await service.json()) as { id: string });
    const terms = {
      code,
      name,
      kind: "percent",
      value: 1500,
      eligibleKinds: ["service"],
      serviceIds: [serviceId],
      startsAt: new Date(Date.now() - 3600000).toISOString(),
      endsAt: new Date(Date.now() + 86400000).toISOString(),
      showOnline: true,
    };
    const created = await owner.post("/api/admin/rewards/promotions", { data: terms });
    expect(created.status(), await created.text()).toBe(201);
    promotion = await created.json();
    if (!promotion) throw new Error("The fixture promotion was not saved");

    await page.goto("/");
    const storefront = page.getByRole("region", { name: "Flash offers" });
    await expect(storefront.getByRole("heading", { name })).toBeVisible();
    await expectNoHorizontalScroll(page);
    const book = storefront.getByRole("link", { name: `Book with ${name}` });
    await book.focus();
    await book.press("Enter");
    await expect(page).toHaveURL(/\/book\?services=/);

    await signInThroughUi(page, fixture.clientEmail, `/book?services=${serviceId}`);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await pickProfessional(page, "Stylist A");
    await pickFirstTime(page);
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    const review = page.getByRole("button", { name: `Review offer ${name}` });
    await review.focus();
    await review.press("Enter");
    await expect(page.getByText("Save €15 · Booking total €85", { exact: true })).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expectNoSeriousA11yViolations(page, "reviewed flash offer");

    const withdrawn = await owner.put(`/api/admin/rewards/promotions/${promotion.id}`, {
      data: { ...terms, showOnline: false, version: promotion.version },
    });
    expect(withdrawn.status()).toBe(200);
    await page.goto("/");
    await expect(page.getByRole("heading", { name })).toHaveCount(0);
  } finally {
    if (serviceId) await owner.delete(`/api/admin/services/${serviceId}`);
    await owner.dispose();
  }
});
