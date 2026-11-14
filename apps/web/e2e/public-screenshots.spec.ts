import { createHmac } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import { createClient, signInThroughUi, uniqueEmail } from "./helpers";
import { firstLink, pathOf, waitForMail } from "./mail";

/**
 * Not assertions: a visual record of the public, auth, consent and notification screens in every
 * language and colour scheme, reviewed by a human. Output is git-ignored (e2e/screenshots).
 */
const LOCALES = [
  { code: "en", tag: "en" },
  { code: "es-AR", tag: "es" },
] as const;
const SCHEMES = ["light", "dark"] as const;
const REDIRECT = "http://127.0.0.1:8976/callback";

function optOutToken(secret: string, clientId: string): string {
  const key = `sob.notifications.v1:${secret}`;
  const body = Buffer.from(JSON.stringify({ c: clientId, ch: "email" })).toString("base64url");
  const sig = createHmac("sha256", key).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

async function pkceChallenge(): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

test.describe("public screenshots", () => {
  const counters = new Map<string, number>();

  test("capture", async ({ page, request, baseURL, context }, testInfo) => {
    test.setTimeout(1_500_000);
    const project = testInfo.project.name;
    const origin = baseURL as string;

    /** One screen in all four language and theme combinations. `act` runs after navigation. */
    const variants = async (
      name: string,
      url: string,
      options: { act?: (p: Page) => Promise<void>; full?: boolean; viaClick?: boolean } = {},
    ) => {
      for (const scheme of SCHEMES) {
        for (const locale of LOCALES) {
          await context.addCookies([{ name: "sob_locale", value: locale.code, url: origin }]);
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(url);
          await page.waitForLoadState("networkidle");
          if (options.act) await options.act(page);
          const n = (counters.get(project) ?? 0) + 1;
          counters.set(project, n);
          await page.waitForTimeout(300);
          await page.screenshot({
            path: `e2e/screenshots/public/${project}/${String(n).padStart(2, "0")}-${name}.${locale.tag}.${scheme}.png`,
            fullPage: options.full ?? true,
            animations: "disabled",
          });
        }
      }
    };

    // ---- sign in / sign up / recovery ----
    await variants("sign-in", "/sign-in");
    await variants("sign-in-empty-submit", "/sign-in", {
      act: async (p) => {
        await p.locator("form button[type=submit]").first().click();
      },
    });
    await variants("sign-in-wrong-password", "/sign-in", {
      act: async (p) => {
        await p.locator("input[type=email]").fill("nobody@example.com");
        await p.locator("input[type=password]").fill("definitely-wrong-password");
        await p.locator("form button[type=submit]").first().click();
        await expect(p.getByRole("alert").first()).toBeVisible();
      },
    });
    await variants("sign-up", "/sign-up");
    await variants("forgot-password", "/forgot-password");
    await variants("forgot-password-sent", "/forgot-password", {
      act: async (p) => {
        await p.locator("input[type=email]").fill(uniqueEmail("ghost"));
        await p.locator("form button[type=submit]").first().click();
        await expect(
          p.getByRole("heading", { level: 1 }).or(p.getByRole("heading")).first(),
        ).toBeVisible();
        await p.waitForTimeout(600);
      },
    });
    await variants("reset-invalid-link", "/reset-password?error=INVALID_TOKEN");
    await variants(
      "verify-email-invalid-link",
      "/verify-email?error=invalid_token&next=%2Faccount",
    );

    // A real reset link, in the form state (token is single use, so mint one per variant).
    const resetClient = await createClient(request, origin);
    let resetCount = 0;
    await variants("reset-password-form", "/forgot-password", {
      act: async (p) => {
        const before = new Set<string>();
        resetCount += 1;
        const res = await p.request.post("/api/auth/request-password-reset", {
          headers: { origin },
          data: { email: resetClient.email, redirectTo: "/reset-password" },
        });
        expect(res.ok(), await res.text()).toBe(true);
        await p.waitForTimeout(800);
        const mail = await waitForMail(resetClient.email, {
          subject: /./,
          ignore: before,
        });
        // newest matching mail first; a stale token is fine because only the form is shot
        await p.goto(pathOf(firstLink(mail)));
        await p.waitForLoadState("networkidle");
      },
    });
    expect(resetCount).toBe(4);
    await variants("reset-password-mismatch", "/reset-password?token=shot-token", {
      act: async (p) => {
        const fields = p.locator("input[type=password]");
        await fields.nth(0).fill("a brand new passphrase 42");
        await fields.nth(1).fill("different");
        await p.locator("form button[type=submit]").first().click();
        await p.waitForTimeout(300);
      },
    });

    // ---- signed in as a fresh client: notification preferences ----
    // The helpers sign in through English labels: leave the last variant's Spanish behind.
    await context.addCookies([{ name: "sob_locale", value: "en", url: origin }]);
    await page.emulateMedia({ colorScheme: "light" });
    const client = await createClient(request, origin);
    await signInThroughUi(page, client.email);
    await expect(page).toHaveURL(/\/account$/);
    await variants("account-notifications", "/account/notifications");
    await variants("account-notifications-saved", "/account/notifications", {
      act: async (p) => {
        await p.locator("input[type=checkbox]").first().click();
        await p.getByRole("button", { name: /^(Save preferences|Guardar preferencias)$/ }).click();
        await p.waitForTimeout(600);
      },
    });

    // ---- OAuth consent screen (the signed-in session carries over) ----
    const registered = await request.post("/api/auth/oauth2/register", {
      headers: { origin },
      data: {
        client_name: "Screenshot MCP host",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope: "mcp:read mcp:book offline_access",
      },
    });
    expect(registered.status(), await registered.text()).toBe(201);
    const clientId = ((await registered.json()) as { client_id: string }).client_id;
    const authorize = async () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        scope: "mcp:read mcp:book offline_access",
        state: "shot",
        code_challenge: await pkceChallenge(),
        code_challenge_method: "S256",
        resource: `${new URL(origin).origin}/mcp`,
      });
      return `/api/auth/oauth2/authorize?${params}`;
    };
    for (const scheme of SCHEMES) {
      for (const locale of LOCALES) {
        await context.addCookies([{ name: "sob_locale", value: locale.code, url: origin }]);
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(await authorize());
        await expect(page).toHaveURL(/\/consent\?/);
        await page.waitForLoadState("networkidle");
        const n = (counters.get(project) ?? 0) + 1;
        counters.set(project, n);
        await page.waitForTimeout(300);
        await page.screenshot({
          path: `e2e/screenshots/public/${project}/${String(n).padStart(2, "0")}-consent.${locale.tag}.${scheme}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
    }
    await variants("consent-invalid-link", "/consent?client_id=abc&scope=mcp%3Aread");

    // ---- opt-out (login free) ----
    const me = (await (await page.request.get("/api/me")).json()) as { clientId: string };
    await context.clearCookies();
    await variants("opt-out-invalid", "/notifications/opt-out?token=not-a-real-token");
    await variants("opt-out-missing-token", "/notifications/opt-out");
    const secret = process.env.E2E_AUTH_SECRET;
    if (secret) {
      const token = encodeURIComponent(optOutToken(secret, me.clientId));
      await variants("opt-out-confirm", `/notifications/opt-out?token=${token}`);
      await variants("opt-out-done", `/notifications/opt-out?token=${token}`, {
        act: async (p) => {
          // the first variant switches reminders off; later ones open the page already switched off
          await p
            .locator("main button")
            .first()
            .click({ timeout: 3000 })
            .catch(() => {});
          await p.waitForTimeout(700);
        },
      });
    }

    // ---- 404 (public) in both languages, plus a loading skeleton of the booking page ----
    await variants("not-found", "/definitely/not/a/page");
  });
});
