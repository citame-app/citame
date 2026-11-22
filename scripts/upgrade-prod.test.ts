import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function exerciseUpgrade(
  probe: "ready" | "after-restart" | "unavailable",
  {
    existing = "recovered",
    stopFails = false,
    migrationSucceeds = false,
    maintenance = true,
    caddy = false,
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "citame-upgrade-test-"));
  const log = join(dir, "commands");
  try {
    await writeFile(
      join(dir, "docker"),
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
case "$*" in
  *'config --format json'*)
    echo '{"services":{"api":{"environment":{"DATABASE_URL":"postgres://sob:next-password@postgres:5432/recovered","VALKEY_URL":"redis://valkey:6379","VALKEY_KEY_PREFIX":"recovery:","SYNC_REPLICA_GENERATION":"recovered"}},"worker":{"environment":{"DATABASE_URL":"postgres://sob:next-password@postgres:5432/recovered","VALKEY_URL":"redis://valkey:6379","VALKEY_KEY_PREFIX":"recovery:","SYNC_REPLICA_GENERATION":"recovered"}},"migrate":{"environment":{"DATABASE_URL":"postgres://sob:next-password@postgres:5432/recovered"}}}}' ;;
  *'ps --all --quiet api worker'*) printf 'synthetic-api\\nsynthetic-worker\\n' ;;
  "inspect --format {{json .Config.Env}} synthetic-"*)
    case "$EXISTING" in
      database) database=sob; prefix=recovery:; generation=recovered ;;
      cache) database=recovered; prefix=sob:; generation=recovered ;;
      generation) database=recovered; prefix=recovery:; generation=initial ;;
      *) database=recovered; prefix=recovery:; generation=recovered ;;
    esac
    override=
    database_url="postgres://sob:old-password@postgres:5432/$database"
    case "$EXISTING" in
      override) override=',"PGDATABASE=old_database"' ;;
      port-override)
        database_url="postgres://sob:old-password@postgres/$database"
        override=',"PGPORT=6000"' ;;
      implicit-db) database_url="postgres://sob:old-password@postgres:5432" ;;
      query-db) database_url="$database_url?dbname=old_database" ;;
    esac
    printf '["DATABASE_URL=%s","VALKEY_URL=redis://valkey:6379","VALKEY_KEY_PREFIX=%s","SYNC_REPLICA_GENERATION=%s"%s]\\n' "$database_url" "$prefix" "$generation" "$override" ;;
  *'config --images'*) echo smoke-image ;;
  *'ps --services --status running api worker'*) printf 'api\\nworker\\n' ;;
  *'ps --quiet --status running web'*) echo smoke-web ;;
  *'ps --quiet caddy'*) if [[ "$CADDY_RUNNING" == 1 ]]; then echo smoke-caddy; fi ;;
  *'stop api worker'*) [[ "$STOP_FAILS" != 1 ]] ;;
  *'run --rm --no-deps --pull never -T migrate'*) [[ "$MIGRATION_SUCCEEDS" == 1 ]] ;;
  *'exec -T web bun -e'*)
    [[ "$PROBE" == ready || ( "$PROBE" == after-restart && -f "$RESTARTED" ) ]] ;;
  *'restart --no-deps web'*) touch "$RESTARTED" ;;
esac
`,
      { mode: 0o700 },
    );
    const command = ["bash", "scripts/upgrade-prod.sh", "--prebuilt"];
    if (maintenance) command.push("--maintenance");
    const child = Bun.spawn(command, {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        COMMAND_LOG: log,
        PROBE: probe,
        EXISTING: existing,
        STOP_FAILS: stopFails ? "1" : "0",
        CADDY_RUNNING: caddy ? "1" : "0",
        MIGRATION_SUCCEEDS: migrationSucceeds ? "1" : "0",
        RESTARTED: join(dir, "restarted"),
      },
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    return { code, commands: await readFile(log, "utf8"), stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function failedMaintenance(
  probe: "ready" | "after-restart" | "unavailable",
  existing = "recovered",
  stopFails = false,
) {
  const result = await exerciseUpgrade(probe, { existing, stopFails });
  expect(result.code).toBe(1);
  return result;
}

test("upgrade verifies the Web-to-API path before replacing the running Caddy", async () => {
  const { code, commands } = await exerciseUpgrade("ready", {
    migrationSucceeds: true,
    caddy: true,
  });
  expect(code).toBe(0);
  const services = commands.indexOf("--no-build --pull never --wait api worker web");
  const probe = commands.indexOf("exec -T web bun -e");
  const caddy = commands.indexOf("--force-recreate --wait caddy");
  expect(services).toBeGreaterThan(-1);
  expect(probe).toBeGreaterThan(services);
  expect(caddy).toBeGreaterThan(probe);
});

test("a running Web container with an unreachable API fails the upgrade without refreshing Caddy", async () => {
  const { code, commands, stderr } = await exerciseUpgrade("unavailable", {
    migrationSucceeds: true,
    maintenance: false,
    caddy: true,
  });
  expect(code).toBe(1);
  expect(commands).toContain("exec -T web bun -e");
  expect(commands).not.toContain("--force-recreate --wait caddy");
  expect(commands).not.toContain("start --wait");
  expect(stderr).toContain("The web gateway could not reach the upgraded API");
});

test.each(["database", "cache", "generation"])(
  "upgrade refuses a different %s before stopping writers or migrating",
  async (existing) => {
    const { commands, stderr } = await failedMaintenance("ready", existing);
    expect(stderr).toContain("differs from the existing installation");
    expect(stderr).not.toContain("password");
    expect(commands).not.toContain("stop api worker");
    expect(commands).not.toContain("run --rm --no-deps --pull never -T migrate");
  },
);

test.each(["override", "port-override", "implicit-db", "query-db"])(
  "upgrade refuses ambiguous PostgreSQL destinations (%s) without logging connection details",
  async (existing) => {
    const { commands, stderr } = await failedMaintenance("ready", existing);
    expect(stderr).toContain("unable to verify the installation's storage configuration");
    expect(stderr).not.toContain("old_database");
    expect(stderr).not.toContain("password");
    expect(commands).not.toContain("stop api worker");
  },
);

test("maintenance rollback keeps the live gateway when it reconnects to the previous API", async () => {
  const { commands } = await failedMaintenance("ready");
  expect(commands).toContain("start --wait");
  expect(commands).toContain("exec -T web bun -e");
  expect(commands).not.toContain("restart --no-deps web");
});

test("a failed maintenance stop restarts the original writers without running a migration", async () => {
  const { commands, stderr } = await failedMaintenance("ready", "recovered", true);
  expect(stderr).toContain("Could not stop the writers");
  expect(commands).toContain("start --wait api worker");
  expect(commands).not.toContain("run --rm --no-deps --pull never -T migrate");
});

test("maintenance rollback restarts an unusable gateway and checks its API connection again", async () => {
  const { commands } = await failedMaintenance("after-restart");
  const restart = commands.indexOf("restart --no-deps web");
  expect(restart).toBeGreaterThan(commands.indexOf("exec -T web bun -e"));
  expect(commands.indexOf("exec -T web bun -e", restart)).toBeGreaterThan(restart);
});

test("maintenance rollback reports a gateway that cannot reconnect after restart", async () => {
  const { stderr } = await failedMaintenance("unavailable");
  expect(stderr).toContain("The web gateway could not reach the previous API after restart");
});
