# Self-Hosted Claude Gateway

Route Claude Code from any machine through your own server, using Claude accounts whose credentials live only on that server. The CLI side is `forkoff remote` (npm package `forkoff` >= 1.2.0).

## How it works

```
laptop claude CLI ──HTTPS──▶ your-domain/gw ──▶ api.anthropic.com
   (fkgw_ key)          (injects account OAuth token)
```

- Each Claude account's 1-year OAuth token (from `claude setup-token`, Pro/Max required) is stored AES-256-GCM encrypted in Postgres.
- Users authenticate with username/password and receive a revocable opaque key (`fkgw_...`) — the account token never leaves the server.
- The proxy streams SSE unbuffered and forwards headers verbatim, so new Claude Code capabilities pass through without gateway changes.

## Enabling

The gateway is dormant unless both env vars are set:

| Variable | Value |
|----------|-------|
| `GATEWAY_ENABLED` | `true` |
| `GATEWAY_TOKEN_ENC_KEY` | base64-encoded 32 bytes (`openssl rand -base64 32`) |

If a reverse proxy fronts the app, the `/gw` path must not buffer responses. Caddy: `reverse_proxy app:3000 { flush_interval -1 }`. nginx: `proxy_buffering off; proxy_read_timeout 3600s; proxy_http_version 1.1;`.

## Managing accounts and users

Run on the server (needs `DATABASE_URL` and `GATEWAY_TOKEN_ENC_KEY`):

```bash
npx ts-node scripts/gateway-admin.ts add-account --name main --token sk-ant-oat... --invite-code <code>
npx ts-node scripts/gateway-admin.ts add-user --username alice --account main
npx ts-node scripts/gateway-admin.ts set-invite --account main
npx ts-node scripts/gateway-admin.ts rotate-token --account main --token sk-ant-oat...
npx ts-node scripts/gateway-admin.ts revoke-key --user alice
npx ts-node scripts/gateway-admin.ts disable-user --username alice
npx ts-node scripts/gateway-admin.ts list
```

Accounts with an invite code accept self-signup via `POST /api/gateway/auth/signup` (or `forkoff remote signup`). Tokens expire yearly — rerun `claude setup-token` and `rotate-token`.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /api/gateway/auth/login` | `{username, password, label?}` → `{key, accountName}` |
| `POST /api/gateway/auth/signup` | `{username, password, inviteCode}` → `{accountName}` |
| `GET /api/gateway/health` | `{status, gateway}` |
| `ALL /gw/*` | Authenticated streaming proxy to api.anthropic.com |

## Client setup

```bash
npm install -g forkoff
forkoff remote login --url https://your-domain.com
forkoff remote start
```

`start` writes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into `~/.claude/settings.json`; every new claude session routes through the gateway until `forkoff remote stop`.

## Notes

- Features requiring a claude.ai login are unavailable in proxy mode: Remote Control, voice dictation, `/schedule`, `/code-review ultra`, claude.ai connectors, `/fast`, `/usage`.
- Sharing consumer subscription accounts between multiple people may violate Anthropic's terms; keep the user list to yourself and people covered by your accounts.
- Proxy logs contain method/path/status/duration/user only — never request or response bodies.
