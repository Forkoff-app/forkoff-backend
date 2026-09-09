# Changelog

All notable changes to forkoff-api are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com); versions follow [SemVer](https://semver.org).
Each release is tagged `v<version>` in git.

## [Unreleased]

## [1.1.0] - 2026-09-09

### Added
- Self-hosted Claude gateway (dormant unless `GATEWAY_ENABLED=true` + `GATEWAY_TOKEN_ENC_KEY` set in secrets):
  - `/gw/*` raw streaming reverse proxy to api.anthropic.com with per-user credential injection (SSE passthrough, verbatim header forwarding, no body logging)
  - `POST /api/gateway/auth/login` — username/password → revocable opaque gateway key (`fkgw_...`)
  - `POST /api/gateway/auth/signup` — invite-code-gated self-signup, mapped to the code's Claude account
  - `GET /api/gateway/health` — feature-aware health probe
  - Prisma models `claude_accounts`, `gateway_users`, `gateway_keys` (OAuth tokens AES-256-GCM encrypted at rest; scrypt password hashes; key hashes only)
  - `scripts/gateway-admin.ts` — add-account / add-user / map-user / set-invite / rotate-token / revoke-key / disable-user / list

### Changed
- `main.ts` now creates the app with `bodyParser: false` and mounts JSON/urlencoded parsers explicitly after the gateway proxy, preserving `rawBody` behavior for all existing routes.

## [1.0.1] - earlier
Pre-changelog history; see git log.
