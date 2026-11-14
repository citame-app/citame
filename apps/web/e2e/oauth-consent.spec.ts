import { expect, test } from "@playwright/test";
import { createClient, expectNoSeriousA11yViolations, PASSWORD } from "./helpers";

/**
 * An MCP host's browser leg of the OAuth 2.1 flow, through the real web server: authorize ->
 * sign in -> consent -> redirect back to the client with a code. The client's loopback redirect
 * is answered by a route stub, so no listener is needed.
 */

const REDIRECT = "http://127.0.0.1:8976/callback";

async function pkceChallenge(): Promise<string> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(digest).toString("base64url");
}

async function registerClient(
  request: import("@playwright/test").APIRequestContext,
  name = "E2E MCP host",
) {
  const response = await request.post("/api/auth/oauth2/register", {
    data: {
      client_name: name,
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: "mcp:read mcp:book offline_access",
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { client_id: string }).client_id;
}

async function authorizeUrl(clientId: string, baseURL: string) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    scope: "mcp:read mcp:book offline_access",
    state: "e2e-state",
    code_challenge: await pkceChallenge(),
    code_challenge_method: "S256",
    resource: `${new URL(baseURL).origin}/mcp`,
  });
  return `/api/auth/oauth2/authorize?${params}`;
}

test.describe("OAuth sign-in and consent", () => {
  test("sign in, review the permissions, allow, and land on the client with a code", async ({
    page,
    request,
    baseURL,
  }) => {
    // A real MCP host registers without cookies; register first so the jar is still empty.
    const clientId = await registerClient(request);
    const { email } = await createClient(request, baseURL ?? "");
    let callback: URL | null = null;
    await page.route(`${REDIRECT}**`, (route) => {
      callback = new URL(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>callback</h1>" });
    });

    await page.goto(await authorizeUrl(clientId, baseURL ?? ""));
    // Not signed in: the authorization server sends the visitor to the sign-in page.
    await expect(page).toHaveURL(/\/sign-in\?.*sig=/);
    await expect(page.getByText("continue connecting an app")).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    await expect(page).toHaveURL(/\/consent\?/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Connect E2E MCP host?" }),
    ).toBeVisible();
    await expect(page.getByText("127.0.0.1:8976")).toBeVisible();
    await expect(
      page.getByRole("checkbox", { name: /Book and cancel appointments/ }),
    ).toBeChecked();
    await expect(page.getByRole("checkbox", { name: /View services/ })).toBeDisabled();
    await expectNoSeriousA11yViolations(page, "consent screen");

    await page.getByRole("checkbox", { name: /Book and cancel appointments/ }).uncheck();
    await page.getByRole("button", { name: "Allow access" }).click();
    await expect(page.getByRole("heading", { name: "callback" })).toBeVisible();
    expect(callback).not.toBeNull();
    const url = callback as unknown as URL;
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("e2e-state");
  });

  test("denying returns access_denied to the client and no code", async ({
    page,
    request,
    baseURL,
  }) => {
    const clientId = await registerClient(request, "Another host");
    const { email } = await createClient(request, baseURL ?? "");
    let callback: URL | null = null;
    await page.route(`${REDIRECT}**`, (route) => {
      callback = new URL(route.request().url());
      return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>callback</h1>" });
    });
    await page.goto(await authorizeUrl(clientId, baseURL ?? ""));
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/consent\?/);
    await page.getByRole("button", { name: "Deny" }).click();
    await expect(page.getByRole("heading", { name: "callback" })).toBeVisible();
    const url = callback as unknown as URL;
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("code")).toBeNull();
  });

  test("the consent screen reads in Spanish and has no serious accessibility issues", async ({
    page,
    request,
    baseURL,
    context,
  }) => {
    const clientId = await registerClient(request, "Host de prueba");
    const { email } = await createClient(request, baseURL ?? "");
    await context.addCookies([
      { name: "sob_locale", value: "es-AR", url: baseURL ?? "http://localhost:4173" },
    ]);
    await page.goto(await authorizeUrl(clientId, baseURL ?? ""));
    await page.getByLabel("Correo electrónico").fill(email);
    await page.getByLabel("Contraseña", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Ingresar", exact: true }).click();
    await expect(
      page.getByRole("heading", { level: 1, name: "¿Conectar Host de prueba?" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Permitir acceso" })).toBeVisible();
    await expectNoSeriousA11yViolations(page, "consent screen (es-AR)");
  });

  test("a hand-made /consent link is not a valid request", async ({ page, request, baseURL }) => {
    const { email } = await createClient(request, baseURL ?? "");
    await page.goto("/sign-in");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL(/\/account$/);
    await page.goto("/consent?client_id=abc&scope=mcp%3Aread");
    await expect(page.getByText("This link is not valid")).toBeVisible();
  });
});
