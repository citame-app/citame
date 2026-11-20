"""Compare Compose storage destinations without printing credentials."""

import json
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit


def read(command):
    return subprocess.check_output(command, stderr=subprocess.PIPE, text=True, timeout=10)


def destination(env, variable, default_port):
    url = urlsplit(env[variable])
    if not url.hostname:
        raise ValueError("missing host")
    scheme = "postgres" if url.scheme == "postgresql" else url.scheme
    path = unquote(url.path)
    query = parse_qsl(url.query, keep_blank_values=True)
    if variable == "DATABASE_URL" and (
        scheme != "postgres"
        or not path.startswith("/")
        or len(path) <= 1
        or (url.port is None and env.get("PGPORT") not in (None, "", str(default_port)))
        or env.get("PGDATABASE") not in (None, "", path[1:])
        or any(key.lower() in ("host", "hostaddr", "port", "dbname", "service") for key, _ in query)
    ):
        raise ValueError("ambiguous PostgreSQL destination")
    return (
        scheme, url.hostname, url.port or default_port, path,
        tuple(sorted(query, key=lambda item: item[0])),
    )


def storage(env):
    return (
        destination(env, "DATABASE_URL", 5432),
        destination(env, "VALKEY_URL", 6379),
        env.get("VALKEY_KEY_PREFIX", "sob:"),
        env.get("SYNC_REPLICA_GENERATION", "initial"),
    )


def container_environment(container):
    entries = json.loads(read(["docker", "inspect", "--format", "{{json .Config.Env}}", container]))
    return dict(entry.split("=", 1) for entry in entries)


def check(mode, compose):
    def refuse(reason):
        sys.exit(f"{mode.capitalize()} refused: {reason}")

    def running(service):
        containers = read(compose + ["ps", "--quiet", "--status", "running", service]).split()
        if not containers:
            refuse(f"the {service} service has no running container.")
        return containers

    try:
        services = json.loads(read(compose + ["config", "--format", "json"]))["services"]
        api_env = services["api"]["environment"]
        desired = storage(api_env)
        if (
            storage(services["worker"]["environment"]) != desired
            or destination(services["migrate"]["environment"], "DATABASE_URL", 5432) != desired[0]
        ):
            refuse("API, worker and migrator target different storage.")

        if mode == "recovery":
            containers = running("api") + running("worker")
        else:
            containers = read(compose + ["ps", "--all", "--quiet", "api", "worker"]).split()
            if not containers:
                refuse("no existing API or worker container was found.")

        for container in containers:
            if storage(container_environment(container)) != desired:
                refuse(
                    "the database, cache namespace or sync generation differs from the existing "
                    "installation. Load the intended deployment environment and verify the "
                    "containers were created with it before retrying."
                )
        if mode == "recovery":
            expected_upstream = ("http", "api", int(api_env.get("PORT", 3000)))
            web_container_envs = [container_environment(container) for container in running("web")]
            for env in [services["web"]["environment"], *web_container_envs]:
                upstream = urlsplit(env["API_INTERNAL_URL"])
                if (
                    upstream.username is not None
                    or upstream.password is not None
                    or upstream.path not in ("", "/")
                    or upstream.query
                    or upstream.fragment
                    or destination(env, "API_INTERNAL_URL", 80)[:3] != expected_upstream
                ):
                    refuse("the web gateway does not use the selected Compose API service.")
    except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError):
        refuse("unable to verify the installation's storage configuration.")


if __name__ == "__main__":
    if len(sys.argv) < 3 or sys.argv[1] not in ("upgrade", "recovery"):
        sys.exit("Usage: check-compose-storage.py <upgrade|recovery> <compose command...>")
    check(sys.argv[1], sys.argv[2:])
