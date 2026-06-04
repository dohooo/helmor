# @helmor/registry

The only Helmor-operated service in the [mobile browser companion](../../docs/mobile-browser-companion-plan.md)
architecture. A Cloudflare Worker that writes **one `remote-<random>.helmor.ai`
CNAME per paired desktop**, pointing at that desktop's Cloudflare Tunnel.

It is deliberately minimal-trust:

- It **never** sees the PAT or any user data — only a tunnel UUID and (for rate
  limiting) the caller IP.
- It only **creates/deletes CNAMEs in the `remote-*` namespace**. Even though the
  API token is zone-wide (`helmor.ai`), the Worker refuses to operate on any
  hostname outside `^remote-…\.helmor\.ai$`, and on revoke it deletes only the
  specific record id it stored.
- KV records carry no identity field (no email, no login).

## API

| Method | Path | Auth | Body / result |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | `{ status, service }` |
| `POST` | `/api/devices/register` | per-IP rate limit | `{ tunnelUuid }` → `{ deviceId, hostname, secret }` |
| `DELETE` | `/api/devices/:id` | `Bearer <secret>` | `204` |

## Configuration

| Binding / var | Where | Notes |
| --- | --- | --- |
| `DEVICES` (KV) | `wrangler.jsonc` | device records + rate-limit counters |
| `CF_API_TOKEN` | **Worker secret** | `Zone:DNS:Edit` on `helmor.ai`; never committed |
| `CF_ZONE_ID` | `wrangler.jsonc` var | the `helmor.ai` zone id |
| `ROOT_DOMAIN` | `wrangler.jsonc` var | `helmor.ai` |
| `HOSTNAME_PREFIX` | var (opt) | default `remote-` |
| `REGISTER_RATE_LIMIT` | var (opt) | default `10` per IP / 24h |
| account id | `CLOUDFLARE_ACCOUNT_ID` env | read by wrangler |

The KV id and zone id in `wrangler.jsonc` are placeholders (non-secret
identifiers); fill them in for your account before deploying.

## Deploy

```bash
cd apps/registry
bun install
export CLOUDFLARE_ACCOUNT_ID=<account-id>
# edit wrangler.jsonc: set the KV id + CF_ZONE_ID
wrangler secret put CF_API_TOKEN   # paste the DNS:Edit token
bun run deploy
```

## Test

```bash
cd apps/registry && bun test
```
