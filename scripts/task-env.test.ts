import { expect, test } from "bun:test";

test("the root e2e command preserves custom test services and account-email settings", async () => {
  const child = Bun.spawn(["bunx", "turbo", "run", "e2e", "--filter=@sob/web", "--dry=json"], {
    env: {
      ...process.env,
      E2E_MAILPIT_URL: "http://localhost:18025",
      E2E_AUTH_SECRET: "test-link-secret-do-not-use-in-production",
      DATABASE_URL: "postgres://sob:sob@localhost:15432/sob",
      VALKEY_URL: "redis://localhost:16379",
      BETTER_AUTH_SECRET: "test-api-secret-do-not-use-in-production",
      SMTP_URL: "smtp://localhost:11025",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  const task = JSON.parse(output).tasks.find(
    (entry: { taskId: string }) => entry.taskId === "@sob/web#e2e",
  );
  const env = task.environmentVariables;
  const names = [...(env.configured ?? []), ...(env.passthrough ?? [])].map(
    (value: string) => value.split("=")[0],
  );
  for (const name of [
    "E2E_MAILPIT_URL",
    "E2E_AUTH_SECRET",
    "DATABASE_URL",
    "VALKEY_URL",
    "BETTER_AUTH_SECRET",
    "SMTP_URL",
  ]) {
    expect(names).toContain(name);
  }
}, 15_000);

/** Use Turbo's resolved task configuration, including its actual environment filtering. */
test("the root dev command passes application configuration through to the API", async () => {
  const probe = "sob-dev-probe-do-not-use-in-production";
  const child = Bun.spawn(["bunx", "turbo", "run", "dev", "--filter=@sob/api", "--dry=json"], {
    env: { ...process.env, BETTER_AUTH_SECRET: probe, DB_POOL_MAX: "3" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  const task = JSON.parse(output).tasks.find(
    (entry: { taskId: string }) => entry.taskId === "@sob/api#dev",
  );
  expect(task).toBeDefined();
  expect(task.resolvedTaskDefinition.cache).toBe(false);
  const env = task.environmentVariables;
  const names = [...(env.configured ?? []), ...(env.passthrough ?? [])].map(
    (value: string) => value.split("=")[0],
  );
  expect(names).toContain("BETTER_AUTH_SECRET");
  expect(names).toContain("DB_POOL_MAX");
  // Dry runs and logs must not expose credential values.
  expect(output).not.toContain(probe);
}, 15_000);
