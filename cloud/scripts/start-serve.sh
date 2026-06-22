#!/usr/bin/env bash
#
# Launch the headless Helmor companion server inside the container.
#
# Started as a MANAGED SUBPROCESS by the CF Worker (`sandbox.startProcess`) or
# the PR6 boot orchestration — never as PID 1 (the CF control server owns that).
#
# Steps (matches the S1 spike's validated production model):
#   1. Start an INDEPENDENT Xvfb display daemon (GTK/WebKit init needs a display
#      connection even though the serve host creates no window).
#   2. Wait for the X11 socket to appear (readiness check).
#   3. Export DISPLAY, then exec `helmor serve` — which binds the companion on
#      0.0.0.0:$HELMOR_SERVE_PORT using $HELMOR_COMPANION_TOKEN.
set -euo pipefail

HELMOR_HOME="${HELMOR_HOME:-/opt/helmor}"
DISPLAY_NUM="${HELMOR_XVFB_DISPLAY:-99}"
export DISPLAY=":${DISPLAY_NUM}"

# Vendored gh + the helmor binaries on PATH (PR6 boot shells out to `gh` /
# `helmor-cli`).
export PATH="${HELMOR_HOME}/vendor/gh:${HELMOR_HOME}/vendor/glab:${HELMOR_HOME}:${PATH}"
export HELMOR_SIDECAR_PATH="${HELMOR_SIDECAR_PATH:-${HELMOR_HOME}/helmor-sidecar}"

# Point the COMPILED sidecar at the vendored claude-code binary. The sidecar is
# `bun build --compile` output with no node_modules, so its only way to resolve
# claude-code in the container is this env var — without it Claude turns silently
# hang (the SDK can't spawn the binary). codex has a relative-path fallback so it
# doesn't need this. Guarded so it's inert if the binary isn't staged.
_claude_bin="${HELMOR_HOME}/vendor/claude-code/claude"
if [ -f "$_claude_bin" ]; then
	chmod +x "$_claude_bin" 2>/dev/null || true
	export HELMOR_CLAUDE_CODE_BIN_PATH="${HELMOR_CLAUDE_CODE_BIN_PATH:-$_claude_bin}"
fi

# Phase 2b: the data dir must live under an allowed backup root (/home, /workspace,
# /tmp, /var/tmp, /app) so the Sandbox backup API can snapshot it. Default to
# /home/helmor; the Worker may override via startProcess env. `helmor serve` AND
# boot.sh both honor this default so they share ONE database.
export HELMOR_DATA_DIR="${HELMOR_DATA_DIR:-/home/helmor}"

# Cloud workflow closure (PR6): commit + push each finished agent turn so the
# ephemeral sandbox disk never loses code. On by default in the container.
export HELMOR_CLOUD_AUTOPUSH="${HELMOR_CLOUD_AUTOPUSH:-1}"

# Git identity for the auto-commit hook (boot.sh sets the same; repeat here so
# auto-commit always has an author even if boot.sh hasn't run yet).
git config --global user.name "${HELMOR_GIT_NAME:-Helmor Cloud}" || true
git config --global user.email "${HELMOR_GIT_EMAIL:-cloud@helmor.app}" || true
git config --global --add safe.directory '*' || true

# Idempotency: the Worker calls startProcess on every not-yet-ready request, so
# bail out if a serve host is already running — a second one would fight for the
# companion port and neither would bind cleanly.
if pgrep -f "${HELMOR_HOME}/helmor serve" >/dev/null 2>&1; then
	echo "helmor-start-serve: serve already running; nothing to do"
	exit 0
fi

# Cloud run identity (subscription): the Worker injects the ChatGPT auth.json via
# CODEX_AUTH_JSON; drop it where codex looks (CODEX_HOME, default ~/.codex) so the
# agent authenticates as the user's subscription. Verified end-to-end in-container
# (codex login status = "Logged in using ChatGPT", real turn completed). Phase-1
# will inject a per-turn short-lived token from the control-plane broker instead.
if [ -n "${CODEX_AUTH_JSON:-}" ]; then
	codex_dir="${CODEX_HOME:-${HOME:-/root}/.codex}"
	mkdir -p "$codex_dir"
	printf '%s' "$CODEX_AUTH_JSON" >"$codex_dir/auth.json"
	chmod 600 "$codex_dir/auth.json"
	echo "helmor-start-serve: wrote $codex_dir/auth.json ($(wc -c <"$codex_dir/auth.json") bytes)"
fi

# Cloud run identity (Claude subscription): the Worker injects the Claude OAuth
# token as the CLAUDE_CODE_OAUTH_TOKEN env var (inherited by claude-code through
# the serve process — no file write needed). Two guards are REQUIRED so the token
# actually wins (claude-cloud-auth-VERIFIED.md §2.6):
#
#   (a) ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN silently OUTRANK
#       CLAUDE_CODE_OAUTH_TOKEN in non-interactive mode (VERIFIED §1.4) — the
#       cloud Agent SDK runs non-interactively, so a stray container secret would
#       silently win and run on the wrong credential. Unset both defensively.
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN

#   (b) A fresh container has no ~/.claude.json, so claude-code may run first-run
#       onboarding and ignore the token (VERIFIED §2.6 / RISK-2). Seed the
#       onboarding flag (the `hasCompletedOnboarding` field is binary-verified in
#       claude-code 2.1.173). This file holds NO secret — just the flag — and is
#       distinct from ~/.claude/.credentials.json (which we never write, so the
#       Linux child-launch guard that prefers a credentials-file refreshToken
#       can't strip our env var — VERIFIED RISK-4).
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
	claude_cfg="${CLAUDE_CONFIG_DIR:-${HOME:-/root}}/.claude.json"
	mkdir -p "$(dirname "$claude_cfg")"
	[ -f "$claude_cfg" ] || printf '%s' '{"hasCompletedOnboarding":true}' >"$claude_cfg"
fi

# Forge git push/clone: wire the synced gh/glab credentials into git so HTTPS
# remotes authenticate. gh writes its own per-host helper; glab needs one per
# host (the local dev launcher passes the configured hosts via HELMOR_GLAB_HOSTS).
# Best-effort — never block serve startup.
if command -v gh >/dev/null 2>&1 && [ -f "${HOME:-/root}/.config/gh/hosts.yml" ]; then
	gh auth setup-git >/dev/null 2>&1 || true
fi
if command -v glab >/dev/null 2>&1 && [ -n "${HELMOR_GLAB_HOSTS:-}" ]; then
	IFS=',' read -ra _glab_hosts <<<"$HELMOR_GLAB_HOSTS"
	for _h in "${_glab_hosts[@]}"; do
		[ -n "$_h" ] || continue
		git config --global "credential.https://${_h}.helper" "" || true
		git config --global --add "credential.https://${_h}.helper" \
			"!glab auth git-credential" || true
	done
fi

# 1. Independent Xvfb daemon (idempotent — skip if one is already running).
if ! pgrep -x Xvfb >/dev/null 2>&1; then
	# The container fs persists across restart (docker start / CF sandbox wake),
	# so a dead Xvfb's socket + lock survive: the stale socket fools the readiness
	# check below (→ helmor serve GTK-init panics) and the lock blocks a new Xvfb
	# from claiming the display. None is running here, so any leftover is stale.
	rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
	Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
fi

# 2. Readiness: wait up to ~10s for the X11 socket.
socket="/tmp/.X11-unix/X${DISPLAY_NUM}"
for _ in $(seq 1 100); do
	[ -S "$socket" ] && break
	sleep 0.1
done
if [ ! -S "$socket" ]; then
	echo "helmor-start-serve: Xvfb display ${DISPLAY} did not come up" >&2
	cat /tmp/xvfb.log >&2 || true
	exit 1
fi

# 3. Hand off to the headless serve host (parks the main thread; spawned tasks
#    run the companion server).
exec "${HELMOR_HOME}/helmor" serve
