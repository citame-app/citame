import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stop at Compose validation: exercise the real script and its EXIT cleanup without Docker. */
async function failedValidation(smokeEmail = false, smokeDesktop = false) {
  const dir = mkdtempSync(join(tmpdir(), "sob-smoke-regression-"));
  const log = join(dir, "commands");
  const docker = join(dir, "docker");
  await Bun.write(
    docker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SMOKE_COMMAND_LOG"
printf 'sms=%s tag=%s\\n' "$NOTIFY_SMS_PROVIDER" "$SOB_TAG" >> "$SMOKE_COMMAND_LOG"
printf 'email=%s url=%s file=%s\\n' "$NOTIFY_EMAIL_PROVIDER" "$SMTP_URL" "$SMTP_URL_FILE" >> "$SMOKE_COMMAND_LOG"
printf 'payments=%s\\n' "$PAYMENT_PROVIDER" >> "$SMOKE_COMMAND_LOG"
printf 'recurring=%s\\n' "$REDSYS_RECURRING_ENABLED" >> "$SMOKE_COMMAND_LOG"
printf 'billing-key=%s file=%s\\n' "$PAYMENT_TOKEN_ENCRYPTION_KEY" "$PAYMENT_TOKEN_ENCRYPTION_KEY_FILE" >> "$SMOKE_COMMAND_LOG"
printf 'meta=%s mcp=%s\\n' "$META_WHATSAPP_APP_ID" "$MCP_RESOURCE_URL" >> "$SMOKE_COMMAND_LOG"
printf 'caddy=%s %s\\n' "$CADDY_HTTP_PORT" "$CADDY_HTTPS_PORT" >> "$SMOKE_COMMAND_LOG"
printf 'recovery=%s %s %s\\n' "$SOB_DATABASE_NAME" "$VALKEY_KEY_PREFIX" "$SYNC_REPLICA_GENERATION" >> "$SMOKE_COMMAND_LOG"
printf 'compose-images=%s %s\\n' "$SOB_API_IMAGE" "$SOB_WEB_IMAGE" >> "$SMOKE_COMMAND_LOG"
exit 23
`,
  );
  chmodSync(docker, 0o700);
  try {
    const child = Bun.spawn(["bash", "scripts/smoke-prod.sh"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SMOKE_COMMAND_LOG: log,
        COMPOSE_PROJECT_NAME: "real-salon",
        NOTIFY_SMS_PROVIDER: "twilio",
        NOTIFY_EMAIL_PROVIDER: "smtp",
        SMTP_URL: "smtps://live.example:465",
        SMTP_URL_FILE: "/private/deployment-smtp",
        SMOKE_EMAIL: smokeEmail ? "1" : "0",
        SMOKE_DESKTOP: smokeDesktop ? "1" : "0",
        PAYMENT_PROVIDER: "redsys",
        REDSYS_RECURRING_ENABLED: "true",
        PAYMENT_TOKEN_ENCRYPTION_KEY: "synthetic-deployment-token-key",
        PAYMENT_TOKEN_ENCRYPTION_KEY_FILE: "/private/deployment-token-key",
        META_WHATSAPP_APP_ID: "12345678",
        MCP_RESOURCE_URL: "https://live.example/mcp",
        SOB_TAG: "live",
        SOB_API_IMAGE: "live-api",
        SOB_WEB_IMAGE: "live-web",
        SOB_DATABASE_NAME: "live_recovered",
        VALKEY_KEY_PREFIX: "live:recovered:",
        SYNC_REPLICA_GENERATION: "live-recovered",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stdout + stderr).toBe(23);
    return readFileSync(log, "utf8").trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("smoke failure cleans up only its unique project and ignores the deployment .env", async () => {
  const first = await failedValidation();
  const second = await failedValidation();
  const commands = first.filter((line) => line.startsWith("compose "));
  expect(commands).toHaveLength(2);
  const project = commands[0]?.match(/--project-name (sob-smoke-[a-z0-9-]+)/)?.[1];
  expect(project).toBeDefined();
  for (const command of commands) {
    expect(command).toContain(`--project-name ${project} `);
    expect(command).toContain("--env-file /dev/null");
    expect(command).not.toContain("real-salon");
  }
  expect(commands[1]).toContain("down -v --remove-orphans");
  expect(second[0]).not.toContain(`--project-name ${project} `);
});

test("smoke never inherits a real SMS provider or overwrites deployment image tags", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("sms="));
  expect(settings).toHaveLength(3);
  for (const line of settings) expect(line).toMatch(/^sms=none tag=sob-smoke-[a-z0-9-]+$/);
  const images = lines.filter((line) => line.startsWith("compose-images="));
  expect(images).toHaveLength(3);
  for (const line of images)
    expect(line).toMatch(/^compose-images=sob-api:(sob-smoke-[a-z0-9-]+) sob-web:\1$/);
});

test("smoke email only uses the private sink when explicitly enabled", async () => {
  for (const [enabled, expected] of [
    [false, "email=none url= file="],
    [true, "email=smtp url=smtp://mailpit:1025 file="],
  ] as const) {
    const lines = await failedValidation(enabled);
    const settings = lines.filter((line) => line.startsWith("email="));
    expect(settings).toEqual([expected, expected, expected]);
    const commands = lines.filter((line) => line.startsWith("compose "));
    for (const command of commands) expect(command.includes("/mail.yaml")).toBe(enabled);
  }
});

test("smoke cleanup removes only the images tagged for that run", async () => {
  const lines = await failedValidation();
  const settings = lines.find((line) => line.startsWith("sms="));
  const tag = settings?.match(/tag=(sob-smoke-[a-z0-9-]+)/)?.[1];
  expect(tag).toBeDefined();
  expect(lines).toContain(`image rm sob-api:${tag} sob-web:${tag}`);
});

test("production smoke never enables an inherited bank gateway", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("payments="));
  expect(settings).toHaveLength(3);
  for (const line of settings) expect(line).toBe("payments=none");
});

test("production smoke disables inherited automatic bank billing", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("recurring="));
  expect(settings).toHaveLength(3);
  for (const line of settings) expect(line).toBe("recurring=false");
  expect(lines.filter((line) => line.startsWith("billing-key="))).toEqual(
    Array(3).fill("billing-key= file="),
  );
});

test.each(["disabled", "plain", "file"] as const)(
  "production Compose keeps recurring billing configuration in the API (%s)",
  async (mode) => {
    const optIn = mode !== "disabled";
    const key = mode === "plain" ? "synthetic-test-token-key" : "";
    const keyFile = mode === "file" ? "/run/secrets/test-token-key" : "";
    const child = Bun.spawn(
      [
        "docker",
        "compose",
        "--env-file",
        "/dev/null",
        "-f",
        "compose.prod.yaml",
        "--profile",
        "setup",
        "config",
        "--format",
        "json",
      ],
      {
        env: {
          PATH: process.env.PATH,
          POSTGRES_PASSWORD: "synthetic-test-password",
          BETTER_AUTH_SECRET: "synthetic-test-auth-secret-for-compose",
          PUBLIC_URL: "https://compose.example",
          PAYMENT_PROVIDER: optIn ? "redsys" : "none",
          REDSYS_SECRET_KEY: optIn ? "synthetic-test-redsys-key" : "",
          REDSYS_RECURRING_ENABLED: optIn ? "true" : "",
          PAYMENT_TOKEN_ENCRYPTION_KEY: key,
          PAYMENT_TOKEN_ENCRYPTION_KEY_FILE: keyFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const { services } = JSON.parse(stdout);
    expect(services.api.environment).toMatchObject({
      REDSYS_RECURRING_ENABLED: String(optIn),
      PAYMENT_TOKEN_ENCRYPTION_KEY: key,
      PAYMENT_TOKEN_ENCRYPTION_KEY_FILE: keyFile,
    });
    for (const name of ["worker", "bootstrap-owner"]) {
      expect(services[name].environment).toMatchObject({
        PAYMENT_PROVIDER: "none",
        REDSYS_SECRET_KEY: "",
        REDSYS_RECURRING_ENABLED: "false",
        PAYMENT_TOKEN_ENCRYPTION_KEY: "",
        PAYMENT_TOKEN_ENCRYPTION_KEY_FILE: "",
      });
    }
  },
);

test("production smoke clears inherited Meta and MCP endpoints", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("meta="));
  expect(settings).toHaveLength(3);
  for (const line of settings) expect(line).toBe("meta= mcp=");
});

test("production smoke exposes the proxy only on loopback", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("caddy="));
  expect(settings).toHaveLength(3);
  for (const line of settings) expect(line).toBe("caddy=127.0.0.1:8088 127.0.0.1:8443");
});

test("the disposable stack starts with its own database, cache and sync history", async () => {
  const lines = await failedValidation();
  const settings = lines.filter((line) => line.startsWith("recovery="));
  expect(settings).toEqual(Array(3).fill("recovery=sob sob: initial"));
});

test("desktop burst limits are applied only to the disposable desktop run", async () => {
  const normal = (await failedValidation()).filter((line) => line.startsWith("compose "));
  expect(normal.every((line) => !line.includes("/desktop-limits.yaml"))).toBe(true);
  const desktop = (await failedValidation(false, true)).filter((line) =>
    line.startsWith("compose "),
  );
  expect(desktop.every((line) => line.includes("/desktop-limits.yaml"))).toBe(true);
});
