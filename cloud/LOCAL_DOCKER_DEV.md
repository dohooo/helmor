# Local Docker-backed Team Mode

This profile runs the Team Cloud HTTP shape locally without keeping a remote
Cloudflare Sandbox/Container alive.

```text
Helmor desktop Team Mode
  -> http://127.0.0.1:8787 local Worker-shaped proxy
  -> http://127.0.0.1:18080 Docker container running `helmor serve`
```

The desktop still only stores `TeamConfig { url, token }`. It does not know
about Docker, volumes, container names, or ports.

## Build

From `cloud/`:

```bash
bun run build:docker:local
```

On Apple Silicon this builds `linux/arm64` by default. Override when needed:

```bash
HELMOR_LOCAL_TEAM_PLATFORM=linux/amd64 bun run build:docker:local
```

The image tag defaults to `helmor-team-local:dev`. The local image uses
`cloud/Dockerfile.local`, which runs `/usr/local/bin/helmor-start-serve`
directly. The root `Dockerfile` remains the Cloudflare Sandbox/staging image.

## Run

```bash
bun run dev:docker
```

The command:

- starts or reuses container `helmor-team-local-dev`;
- binds companion `127.0.0.1:18080 -> 8080`;
- mounts Docker volumes for `/home/helmor` and `/workspace`;
- starts the local Team proxy on `http://127.0.0.1:8787`;
- writes local state under `../.local-data/team-docker`.

The script prints the Team URL, a default member token, and an admin token.
Enter the URL and member token in Settings -> Team, test the connection, then
enable Team Mode. The admin token is only for bootstrap/admin operations.

## Credentials

Codex credentials are copied from `~/.codex/auth.json` and
`~/.codex/config.toml` into the local state directory and mounted into the
container. The whole `~/.codex` tree is intentionally not copied.

Optional env:

```bash
HELMOR_LOCAL_TEAM_CODEX_HOME=~/.codex
GITHUB_TOKEN=...
CLAUDE_CODE_OAUTH_TOKEN=...
```

## Security Contract

The local proxy mirrors the Worker trust boundary:

- client-supplied `X-Helmor-Member-Id` is always stripped;
- member id is derived from the bearer invite token stored in the local registry;
- the proxy swaps the client bearer for `HELMOR_COMPANION_TOKEN` only on the
  proxy-to-companion hop;
- the trusted `X-Helmor-Member-Id` header is injected only on that hop;
- unknown bearer tokens return 401 before reaching the companion.

Local cloud identity routes keep the same shapes as the Worker, but store only
metadata in the local registry. For actual agent turns, use local mounted CLI
credentials.

## Useful Overrides

```bash
HELMOR_LOCAL_TEAM_PORT=8787
HELMOR_LOCAL_TEAM_COMPANION_PORT=18080
HELMOR_LOCAL_TEAM_IMAGE=helmor-team-local:dev
HELMOR_LOCAL_TEAM_CONTAINER=helmor-team-local-dev
HELMOR_LOCAL_TEAM_STATE_DIR=../.local-data/team-docker
HELMOR_LOCAL_TEAM_BUILD=1 bun run dev:docker
```

If a companion is already running, skip Docker and run only the proxy:

```bash
HELMOR_LOCAL_TEAM_COMPANION_BASE=http://127.0.0.1:18189 bun run dev:docker
```

## Validation

At minimum, verify:

- `GET /v1/health`;
- `POST /team/bootstrap`, `/team/invite`, `/team/accept`;
- bad bearer is rejected before proxying;
- forged `X-Helmor-Member-Id` is replaced by the derived member id;
- `/rpc`, `/rpc-stream`, and `/v1/stream` proxy to Docker;
- workspace/session creation, room chat, real agent turn, and historical reload.

Use Wrangler/Cloudflare only as a fidelity or staging profile. Any remote deploy
or Container/Sandbox operation can create billable resources and should be
short-lived with explicit cleanup.
