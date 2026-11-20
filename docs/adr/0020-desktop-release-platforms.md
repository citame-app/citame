# ADR 0020: Native desktop release platforms

Status: accepted

[ADR 0008](0008-desktop-client.md) originally required Linux artifacts and deferred macOS builds. The release workflow now requires Linux x86_64 and native macOS builds for Intel x86_64 and Apple Silicon arm64. The macOS bundles target macOS 15 and later. Each architecture builds and tests on its own runner so SQLite initialization and the packaged executable run on the architecture they target.

Public Mac packages require a Developer ID Application signature, Hardened Runtime, notarization, and a stapled ticket. Verification checks the app extracted from the final ZIP. The executable, archive, and checksums must pass the release workflow before publication. A separate workflow can produce ad hoc signed test bundles without the distribution credentials.

An interactive check on an Intel Mac and an M3 Mac verifies graphics, launch and the connected workflow on the requested hardware. Hosted arm64 package checks and startup callbacks alone provide partial evidence for those checks. See the [release guide](../release.md) for credentials and verification.
