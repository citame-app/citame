# Security policy

## Supported versions

The project is pre-1.0. Only the latest release (and `main`) receives security fixes.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |
| < 0.1   | no        |

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open this repository's **Security** tab and choose **Report a vulnerability** (a private security advisory). Include:

- what you found and the impact you believe it has,
- the version or commit, and how you deployed it (compose profile, reverse proxy),
- steps or a proof of concept that reproduce it,
- whether you plan to disclose it publicly, and when.

Do not include real customer data. If the finding involves a secret that you obtained, say where, but do not use it.

## What to expect

These are intentions for a volunteer-run project, not a contractual SLA.

- Acknowledgement within 7 days.
- A first assessment (accepted, needs more information, or out of scope) within 14 days.
- A fix or mitigation plan for confirmed issues, targeting 90 days at most, sooner for critical ones. Fixes ship in a patch release with a CHANGELOG entry and a GitHub security advisory crediting you, unless you prefer to stay anonymous.
- We ask for coordinated disclosure: please give us the time above before publishing details.

## Scope

In scope:

- the API (`apps/api`): authentication and sessions, RBAC and the policy matrix, booking and double-booking guarantees, sync endpoints, the OAuth 2.1 server and the MCP endpoint, rate limiting, input handling,
- the web app and its server (`apps/web`): XSS, CSRF and open redirect issues, the same-origin proxy, security headers and CSP,
- the desktop client (`apps/desktop`): local session storage, sync handling,
- the Docker images, `compose.prod.yaml`, the Caddy example and the scripts in `scripts/`.

Out of scope:

- vulnerabilities in third-party dependencies with no demonstrable impact on this project (report those upstream; automated dependency alerts are already enabled),
- findings that need a compromised host, database or administrator account,
- missing hardening of a deployment that ignores the documented guidance (for example running `compose.yaml` development defaults on the internet),
- denial of service by raw volume against an instance with no rate limiting or proxy in front of it,
- social engineering of maintainers or users.

## Hardening guidance for operators

[docs/self-hosting.md](docs/self-hosting.md) and [docs/operations.md](docs/operations.md) describe the production setup (TLS, secrets, backups, rotation). The current audit status of dependencies is in [docs/security-review.md](docs/security-review.md).
