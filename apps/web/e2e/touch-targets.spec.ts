import { expect, test } from "@playwright/test";
import { asOwner, OWNER_EMAIL, signInAs } from "./admin-helpers";

/**
 * Touch target audit for phones (WCAG 2.5.5 asks 44 CSS px; 2.5.8 AA asks 24). Lists every
 * visible interactive element smaller than 44 px in either direction on the main screens, so a
 * human can judge each one. Inline links inside a sentence are reported separately: they are
 * exempt from the size rule.
 */
const PUBLIC = ["/", "/book", "/sign-in", "/sign-up", "/forgot-password"];
const ADMIN = [
  "/admin",
  "/admin/calendar",
  "/admin/clients",
  "/admin/services",
  "/admin/staff",
  "/admin/reports",
  "/admin/settings",
];

test.describe("touch targets", () => {
  test("report interactive elements under 44px on a phone", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "phones only");
    test.setTimeout(240_000);
    await (await asOwner()).dispose();
    const found: string[] = [];
    const scan = async (path: string) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const small = await page.evaluate(() => {
        const sel =
          "a[href],button,select,textarea,input:not([type=hidden]),[role=button],[role=checkbox],[role=radio],[role=tab],[role=switch]";
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(sel)) {
          const r = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (r.width === 0 || r.height === 0 || style.visibility === "hidden") continue;
          // the skip link is visually hidden until it takes focus
          if (el.getAttribute("href") === "#main") continue;
          if (el.closest("[aria-hidden=true]")) continue;
          // a hidden native control that a styled label wraps: judge the label
          let box = r;
          if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
            const label = el.closest("label") ?? document.querySelector(`label[for="${el.id}"]`);
            if (label) box = label.getBoundingClientRect();
          }
          if (box.width >= 44 && box.height >= 44) continue;
          const inline =
            el.tagName === "A" &&
            el.closest("p,li,span") !== null &&
            (el.parentElement?.textContent ?? "").trim().length >
              (el.textContent ?? "").trim().length + 6;
          const name = (
            el.getAttribute("aria-label") ||
            el.textContent ||
            el.getAttribute("name") ||
            ""
          )
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 40);
          out.push(
            `${inline ? "[inline] " : ""}${el.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`,
          );
        }
        return out;
      });
      for (const s of small) found.push(`${path}: ${s}`);
    };
    for (const p of PUBLIC) await scan(p);
    await signInAs(page, OWNER_EMAIL, "/admin");
    for (const p of ADMIN) await scan(p);
    console.log(`TOUCH-TARGETS (${found.length})\n${found.join("\n")}`);
    expect(found.filter((f) => !f.includes("[inline]"))).toEqual([]);
  });
});
