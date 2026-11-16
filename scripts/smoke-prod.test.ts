import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Stop at Compose validation: exercise the real script and its EXIT cleanup without Docker. */
async function failedValidation() {
  const dir = mkdtempSync(join(tmpdir(), "sob-smoke-regression-"));
  const log = join(dir, "commands");
  const docker = join(dir, "docker");
  await Bun.write(
    docker,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$SMOKE_COMMAND_LOG"
printf 'sms=%s tag=%s\\n' "$NOTIFY_SMS_PROVIDER" "$SOB_TAG" >> "$SMOKE_COMMAND_LOG"
printf 'payments=%s\\n' "$PAYMENT_PROVIDER" >> "$SMOKE_COMMAND_LOG"
printf 'recurring=%s\\n' "$REDSYS_RECURRING_ENABLED" >> "$SMOKE_COMMAND_LOG"
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
        PAYMENT_PROVIDER: "redsys",
        REDSYS_RECURRING_ENABLED: "true",
        SOB_TAG: "live",
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
});
