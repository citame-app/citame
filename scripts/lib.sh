# Shared helpers for backup.sh / restore.sh. Source it, do not run it.
#
# Each PostgreSQL client tool runs natively when it is installed, otherwise inside the compose
# `postgres` container (same major version as the server, so dumps are always compatible).
# Set PG_MODE=docker to force the container, PG_MODE=native to forbid it. PG_CONTAINER=<name>
# targets a specific container (CI service containers) instead of the compose service.

set -euo pipefail

DEFAULT_URL="postgres://sob:sob@localhost:5432/sob"

# url_part <url> <user|password|host|port|db>
url_part() {
  bun -e '
    const u = new URL(process.argv[1]);
    const part = { user: u.username, password: decodeURIComponent(u.password), host: u.hostname, port: u.port || "5432", db: u.pathname.slice(1) }[process.argv[2]];
    process.stdout.write(part ?? "");
  ' "$1" "$2"
}

use_docker() { # use_docker <tool>
  case "${PG_MODE:-auto}" in
    docker) return 0 ;;
    native) return 1 ;;
    *) ! command -v "$1" >/dev/null 2>&1 ;;
  esac
}

# pg_tool <tool> <url> [args...]   (stdin/stdout pass through)
pg_tool() {
  local tool="$1" url="$2"; shift 2
  local user host port db password
  user="$(url_part "$url" user)"; password="$(url_part "$url" password)"
  host="$(url_part "$url" host)"; port="$(url_part "$url" port)"; db="$(url_part "$url" db)"
  if use_docker "$tool"; then
    # Inside the container the server is reachable on its own socket; credentials are not needed.
    if [ -n "${PG_CONTAINER:-}" ]; then
      docker exec -i "$PG_CONTAINER" "$tool" -U "$user" -d "$db" "$@"
    else
      docker compose exec -T postgres "$tool" -U "$user" -d "$db" "$@"
    fi
  else
    PGPASSWORD="$password" "$tool" -h "$host" -p "$port" -U "$user" -d "$db" "$@"
  fi
}

# admin_url <url>: same server, database `postgres`.
admin_url() { printf '%s' "$1" | sed -E 's#/[^/?]+(\?.*)?$#/postgres#'; }

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
