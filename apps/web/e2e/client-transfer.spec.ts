import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { RECURRING_FIXTURE as fixture } from "../../api/test/recurring-values";
import { expectNoHorizontalScroll } from "./admin-helpers";
import { expectNoSeriousA11yViolations, signInThroughUi, switchLocale } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
  test.describe(`client transfer — ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    test("reviews a real CSV, skips duplicates, recovers a lost import response and exports a searched round trip", async ({
      page,
    }) => {
      const token = crypto.randomUUID().slice(0, 8);
      const name = `Imported ${token}`;
      const formula = `=HYPERLINK("https://example.invalid/${token}")`;
      const tag = `transfer-${token}`;
      const email = `import-${token}@example.invalid`;
      const csv = `name,email,phone,notes,tags\r\n"${name}",${email},+34600111222,"Private note, with comma\nSecond line",${tag};vip\r\n"${formula.replaceAll('"', '""')}",formula-${token}@example.invalid,,Formula text,${tag};colour\r\nRepeated,${email.toUpperCase()},,,\r\nInvalid,invalid,,,`;
      let receipt: { clientIds: string[]; [key: string]: unknown } | undefined;
      try {
        await signInThroughUi(page, fixture.ownerEmail, "/admin/clients");
        await switchLocale(page, "Español");
        await page.getByRole("button", { name: "Importar clientes", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Importar clientes", exact: true });
        await dialog
          .getByLabel("Elegir archivo CSV", { exact: true })
          .setInputFiles({ name: "clients.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
        await dialog.getByRole("button", { name: "Revisar importación", exact: true }).click();
        await expect(
          dialog.getByRole("checkbox", { name: `Importar fila 2: ${name}`, exact: true }),
        ).toBeChecked();
        await expect(
          dialog.getByRole("checkbox", { name: "Importar fila 4: Repeated", exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByRole("checkbox", { name: "Importar fila 5: Invalid", exact: true }),
        ).toBeDisabled();
        await expect(
          dialog.getByText("Escribe un correo válido o deja el campo vacío.", { exact: true }),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "Quitar selección", exact: true }).click();
        await expect(
          dialog.getByRole("button", { name: "Importar 0 clientes", exact: true }),
        ).toBeDisabled();
        await dialog
          .getByRole("button", { name: "Seleccionar todas las fichas nuevas", exact: true })
          .click();
        await expectNoHorizontalScroll(page);
        await expectNoSeriousA11yViolations(page, `Spanish CSV preview ${scheme}`);
        await page.screenshot({
          path: `/tmp/sob-client-transfer-es-${scheme}-${test.info().project.name}.png`,
          fullPage: true,
          animations: "disabled",
        });
        const attempts: unknown[] = [];
        let lost = false;
        await page.route("**/api/admin/clients/import", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          attempts.push(route.request().postDataJSON());
          if (lost) return route.continue();
          lost = true;
          const response = await route.fetch();
          expect(response.status(), await response.text()).toBe(201);
          receipt = await response.json();
          await route.abort("connectionreset");
        });
        await dialog.getByRole("button", { name: "Importar 2 clientes", exact: true }).click();
        await expect(dialog.getByRole("alert")).toBeVisible();
        const recovered = page.waitForResponse(
          (r) => r.url().endsWith("/api/admin/clients/import") && r.request().method() === "POST",
        );
        await dialog.getByRole("button", { name: "Importar 2 clientes", exact: true }).click();
        const replay = await recovered;
        expect(replay.status(), await replay.text()).toBe(201);
        expect(await replay.json()).toEqual(receipt);
        expect(attempts).toHaveLength(2);
        expect(attempts[1]).toEqual(attempts[0]);
        await expect(
          dialog.getByText("Se han importado 2 clientes. Se han omitido 2 filas.", { exact: true }),
        ).toBeVisible();
        await dialog.getByRole("button", { name: "Cerrar", exact: true }).click();
        await page.getByRole("searchbox", { name: "Buscar clientes", exact: true }).fill(tag);
        await expect(page).toHaveURL(new RegExp(`q=${tag}`));
        await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
        await expect(page.getByRole("button", { name: formula, exact: true })).toBeVisible();
        const download = page.waitForEvent("download");
        await page.getByRole("button", { name: "Exportar CSV", exact: true }).click();
        const file = await download;
        expect(file.suggestedFilename()).toMatch(
          /^sisters-of-beauty-clients-\d{4}-\d{2}-\d{2}\.csv$/,
        );
        const path = await file.path();
        if (!path) throw new Error("Missing downloaded export");
        const exported = await readFile(path, "utf8");
        expect(exported).toContain("'=HYPERLINK");
        expect(exported).toContain("'+34600111222");
        expect(exported).toContain("Private note, with comma\nSecond line");
        await page.getByRole("button", { name: "Importar clientes", exact: true }).click();
        await dialog.getByLabel("Elegir archivo CSV", { exact: true }).setInputFiles(path);
        await dialog.getByRole("button", { name: "Revisar importación", exact: true }).click();
        await expect(
          dialog.getByText("Nuevos: 0 · Repetidos: 2 · No válidos: 0 · Contactos en conflicto: 0", {
            exact: true,
          }),
        ).toBeVisible();
        await expect(
          dialog.getByRole("button", { name: "Importar 0 clientes", exact: true }),
        ).toBeDisabled();
        await expectNoSeriousA11yViolations(page, `CSV round trip ${scheme}`);
        const clients = await page.request.get(`/api/admin/clients?search=${tag}`);
        expect((await clients.json()).total).toBe(2);
      } finally {
        for (const id of receipt?.clientIds ?? [])
          await page.request.delete(`/api/admin/clients/${id}`, {
            headers: { origin: fixture.baseURL },
          });
      }
    });
  });
}
