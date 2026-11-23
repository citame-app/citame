# Shared helpers for backup.sh / restore.sh. Source it, do not run it.
#
# Docker fallback is for default-port loopback URLs without connection options.
# Set PG_MODE=docker to use the container socket or PG_MODE=native to require the native tools.
# PG_CONTAINER=<name> selects a specific container instead of the Compose service.

set -euo pipefail

DEFAULT_URL="postgres://sob:sob@localhost:5432/sob"

# url_part <url> <user|password|db|socket|native|admin>
url_part() {
  CITAME_PG_CLIENT_URL="$1" bun -e '
    const uri = process.env.CITAME_PG_CLIENT_URL;
    try {
      const url = new URL(uri);
      const database = decodeURIComponent(url.pathname.slice(1));
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !database || url.hash) {
        throw new Error("Use a PostgreSQL URL with an explicit database path.");
      }
      // libpq uses percent escapes, not form encoding. Keep the raw option values intact.
      const options = url.search ? url.search.slice(1).split("&") : [];
      let password = decodeURIComponent(url.password);
      const safeOptions = options.filter((option) => {
        const equals = option.indexOf("=");
        const key = decodeURIComponent(equals < 0 ? option : option.slice(0, equals));
        if (key === "dbname") throw new Error("Select the database in the URL path.");
        if (key === "sslpassword") throw new Error("Configure sslpassword in a libpq service file.");
        if (key !== "password" || equals < 0) return true;
        password = decodeURIComponent(option.slice(equals + 1));
        return false;
      });
      const plainSocket = !url.search && (!url.port || url.port === "5432")
        && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
      const administratorUrl = new URL(url);
      administratorUrl.pathname = "/postgres";
      url.password = "";
      if (safeOptions.length !== options.length) url.search = safeOptions.join("&");
      const parts = {
        user: decodeURIComponent(url.username), password, db: database,
        socket: plainSocket ? "yes" : "", native: url.href, admin: administratorUrl.href,
      };
      process.stdout.write(parts[process.argv[1]] ?? "");
    } catch (error) {
      // A malformed URL can contain credentials. Do not include the parser input in errors.
      console.error(error.constructor === Error ? error.message : "Invalid PostgreSQL connection URL.");
      process.exitCode = 1;
    }
  ' "$2"
}

use_docker() { # use_docker <tool>
  case "${PG_MODE:-auto}" in
    docker) return 0 ;;
    native) return 1 ;;
    *) ! command -v "$1" >/dev/null 2>&1 ;;
  esac
}

pg_container_tool() {
  if [ "${PG_CONTAINER+x}" ]; then
    [ -n "$PG_CONTAINER" ] || { echo "PG_CONTAINER is set but empty" >&2; return 1; }
    docker exec -i "$PG_CONTAINER" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}

list_restore_archive() {
  if use_docker pg_restore; then
    pg_container_tool pg_restore --list
  else
    pg_restore --list
  fi
}

# pg_tool <tool> <url> [args...]   (stdin/stdout pass through)
pg_tool() {
  local tool="$1" url="$2"; shift 2
  local user db password connection socket
  if use_docker "$tool"; then
    socket="$(url_part "$url" socket)" || return 1
    if [ "$socket" != yes ] || {
      [ "${PG_MODE:-auto}" != docker ] &&
      [ -n "${PGHOSTADDR:-}${PGSERVICE:-}${PGSSLMODE:-}${PGREQUIRESSL:-}" ]
    }; then
      echo "Use native PostgreSQL tools for a remote endpoint or custom connection settings." >&2
      return 1
    fi
    user="$(url_part "$url" user)" || return 1
    db="$(url_part "$url" db)" || return 1
    # Inside the container the server is reachable on its own socket; credentials are not needed.
    pg_container_tool "$tool" -U "$user" -d "$db" "$@"
  else
    connection="$(url_part "$url" native)" || return 1
    password="$(url_part "$url" password)" || return 1
    if [ -n "$password" ]; then
      PGPASSWORD="$password" "$tool" -d "$connection" "$@"
    else
      "$tool" -d "$connection" "$@"
    fi
  fi
}

# admin_url <url>: same server, database `postgres`.
admin_url() { url_part "$1" admin; }

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
