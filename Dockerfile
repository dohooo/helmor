# syntax=docker/dockerfile:1
#
# Helmor headless "serve" image for the Team Cloud Sandbox (Phase 0).
#
# Built FROM the Cloudflare Sandbox base image so the CF Worker can manage the
# container (the base ENTRYPOINT is CF's own :3000 control server — we MUST NOT
# override it). `helmor serve` runs as a managed subprocess launched by the
# Worker (`sandbox.startProcess`) via `cloud/scripts/start-serve.sh`, which
# first brings up an independent Xvfb display (GTK/WebKit init needs a display
# connection even though the serve host creates no window — see the S1 spike).
#
# Lives at the repo ROOT because the build context is the repo root (the stages
# `COPY . .`). Wrangler resolves it via `cloud/wrangler.toml` -> `image =
# "../Dockerfile"`, whose directory (repo root) becomes the build context.
# Native linux/amd64 build (no cross-compile). On Apple Silicon use buildx/QEMU.
#
# Only codex + gh are vendored (T3) — the image stays lean (<1GB). claude-code /
# opencode / llama-cpp / cloudflared are intentionally omitted.

# Declared in the global scope (before the first FROM) so the runtime stage's
# FROM can interpolate it; MUST match @cloudflare/sandbox in cloud/package.json.
ARG SANDBOX_VERSION=0.12.1

# ─── Stage 1: frontend bundle (dist/) — embedded into the Rust binary ────────
# Built on $BUILDPLATFORM (the build host's native arch), NOT the amd64 target.
# dist/ is arch-independent static output, and vite's rolldown bundler ships a
# native module that SIGILLs under QEMU x86_64 emulation on Apple Silicon.
# Building natively dodges the emulator and is faster; on a native amd64 builder
# (CI / Cloudflare) BUILDPLATFORM == TARGETPLATFORM, so the result is identical.
FROM --platform=$BUILDPLATFORM oven/bun:1.3.2 AS frontend
WORKDIR /app
# The repo root is a bun workspace ("." + apps/*); a --frozen-lockfile install
# needs every workspace member's package.json, so copy the full context first
# (node_modules is .dockerignored, so no host arm64 binaries leak in). HUSKY=0
# skips git-hook install (the build context has no .git).
ENV HUSKY=0
COPY . .
RUN bun install --frozen-lockfile
RUN bun run build

# ─── Stage 2: sidecar binary + linux vendor (codex + gh) ─────────────────────
FROM oven/bun:1.3.2 AS sidecar
RUN apt-get update \
	&& apt-get install -y --no-install-recommends curl ca-certificates tar \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY sidecar/package.json sidecar/bun.lock ./sidecar/
RUN cd sidecar && bun install --frozen-lockfile
COPY sidecar ./sidecar
COPY scripts ./scripts
# Native linux build: PR3 stage-vendor stages codex (from node_modules) + gh
# (downloaded release archive); build.ts compiles the sidecar binary natively.
RUN cd sidecar && bun run scripts/stage-vendor.ts && bun run scripts/build.ts

# ─── Stage 3: Rust GUI binary (release) ──────────────────────────────────────
FROM rust:1-bookworm AS rust
# S2 build dependencies (cmake/clang are required by wreq → BoringSSL and are
# not on Tauri's stock list).
RUN apt-get update && apt-get install -y --no-install-recommends \
	libwebkit2gtk-4.1-dev libgtk-3-dev build-essential libxdo-dev libssl-dev \
	libayatana-appindicator3-dev librsvg2-dev pkg-config cmake clang \
	&& rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
# tauri-build embeds frontendDist and validates externalBin for the target
# triple — supply the built frontend + sidecar and the suffixed externalBin
# names before compiling.
COPY --from=frontend /app/dist ./dist
COPY --from=sidecar /app/sidecar/dist ./sidecar/dist
ARG TARGET_TRIPLE=x86_64-unknown-linux-gnu
# Clear any inherited sccache wrapper (would leak the host config into the image).
ENV RUSTC_WRAPPER=
RUN cp sidecar/dist/helmor-sidecar "sidecar/dist/helmor-sidecar-${TARGET_TRIPLE}" \
	&& mkdir -p src-tauri/target/bundled \
	# Stub for the helmor-cli externalBin so build.rs's presence check passes;
	# the real binary is produced by the same cargo build below.
	&& : > "src-tauri/target/bundled/helmor-cli-${TARGET_TRIPLE}"
RUN cd src-tauri && cargo build --release --bin helmor --bin helmor-cli

# ─── Stage 4: runtime layer on the CF Sandbox base ───────────────────────────
# Version MUST match the @cloudflare/sandbox npm dependency in cloud/ (PR5);
# SANDBOX_VERSION is declared once in the global scope near the top of the file.
FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION} AS runtime
# Runtime equivalents of the S2 build libs + xvfb (independent display daemon),
# git (PR6 clone/push), and CA certs.
RUN apt-get update && apt-get install -y --no-install-recommends \
	libwebkit2gtk-4.1-0 libgtk-3-0 libxdo3 libayatana-appindicator3-1 \
	librsvg2-2 xvfb git ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

ENV HELMOR_HOME=/opt/helmor
RUN mkdir -p "$HELMOR_HOME"
COPY --from=rust /app/src-tauri/target/release/helmor "$HELMOR_HOME/helmor"
COPY --from=rust /app/src-tauri/target/release/helmor-cli "$HELMOR_HOME/helmor-cli"
COPY --from=sidecar /app/sidecar/dist/helmor-sidecar "$HELMOR_HOME/helmor-sidecar"
COPY --from=sidecar /app/sidecar/dist/vendor "$HELMOR_HOME/vendor"
COPY cloud/scripts/start-serve.sh /usr/local/bin/helmor-start-serve
COPY cloud/scripts/boot.sh /usr/local/bin/helmor-boot
RUN chmod +x /usr/local/bin/helmor-start-serve /usr/local/bin/helmor-boot \
	"$HELMOR_HOME/helmor" "$HELMOR_HOME/helmor-cli" "$HELMOR_HOME/helmor-sidecar"

# Runtime wiring. `helmor serve` finds the sidecar via HELMOR_SIDECAR_PATH and
# codex via vendor/codex/codex (resolved relative to the helmor binary).
ENV HELMOR_SIDECAR_PATH=/opt/helmor/helmor-sidecar \
	HELMOR_SERVE_PORT=8080 \
	DISPLAY=:99

# `wrangler dev` requires an EXPOSE for each proxied port (production ignores it).
EXPOSE 8080

# DELIBERATELY no ENTRYPOINT / CMD override: the CF base ENTRYPOINT (its :3000
# control server) must remain PID 1. The Worker launches the serve host via
# `sandbox.startProcess("/usr/local/bin/helmor-start-serve")`. For a standalone
# self-hosted `docker run`, exec the same script as a managed process.
