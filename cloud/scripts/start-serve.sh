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
export PATH="${HELMOR_HOME}/vendor/gh:${HELMOR_HOME}:${PATH}"
export HELMOR_SIDECAR_PATH="${HELMOR_SIDECAR_PATH:-${HELMOR_HOME}/helmor-sidecar}"

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

# 1. Independent Xvfb daemon (idempotent — skip if one is already running).
if ! pgrep -x Xvfb >/dev/null 2>&1; then
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
