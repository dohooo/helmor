#!/usr/bin/env bash
#
# Cloud workflow boot orchestration (PR6).
#
# A THIN wrapper over the existing Helmor CLI verbs — it adds nothing the CLI
# can't already do, just sequences them for a fresh sandbox:
#   1. git clone the target repo (PAT injected for a non-interactive clone).
#   2. `helmor repo add <clone_path>`     — register the repo.
#   3. `helmor workspace new --repo <name>` — create a workspace (this also
#      auto-runs the repo's setup script when one is configured).
#
# Run once after the sandbox comes up (the Worker can `sandbox.startProcess`
# this, or it can run ahead of start-serve.sh). Operates on the shared data-dir
# DB; the running serve process observes the new rows via its UI-sync listener.
#
# Required env:  HELMOR_REPO_URL  (the git repo to clone)
# Optional env:  GITHUB_TOKEN, HELMOR_REPO_BRANCH, HELMOR_WORK_ROOT,
#                HELMOR_GIT_NAME, HELMOR_GIT_EMAIL
set -euo pipefail

HELMOR_HOME="${HELMOR_HOME:-/opt/helmor}"
export PATH="${HELMOR_HOME}/vendor/gh:${HELMOR_HOME}:${PATH}"
HELMOR_CLI="${HELMOR_HOME}/helmor-cli"

: "${HELMOR_REPO_URL:?HELMOR_REPO_URL must be set (the git repo to clone)}"
REPO_BRANCH="${HELMOR_REPO_BRANCH:-}"
WORK_ROOT="${HELMOR_WORK_ROOT:-/workspace}"

# Git identity for the auto-commit hook + a non-interactive, sandbox-safe config.
git config --global user.name "${HELMOR_GIT_NAME:-Helmor Cloud}"
git config --global user.email "${HELMOR_GIT_EMAIL:-cloud@helmor.app}"
git config --global --add safe.directory '*'

# Derive a clone path from the repo URL (strip .git, take basename).
repo_name="$(basename "${HELMOR_REPO_URL%.git}")"
clone_path="${WORK_ROOT}/${repo_name}"

# Inject the PAT into the https URL for a non-interactive clone + push. Only
# rewrite https://github.com/... forms; leave ssh / other hosts untouched.
clone_url="$HELMOR_REPO_URL"
if [ -n "${GITHUB_TOKEN:-}" ]; then
	case "$HELMOR_REPO_URL" in
	https://github.com/*)
		clone_url="https://x-access-token:${GITHUB_TOKEN}@github.com/${HELMOR_REPO_URL#https://github.com/}"
		;;
	esac
fi

if [ ! -d "$clone_path/.git" ]; then
	mkdir -p "$WORK_ROOT"
	if [ -n "$REPO_BRANCH" ]; then
		git clone --branch "$REPO_BRANCH" "$clone_url" "$clone_path"
	else
		git clone "$clone_url" "$clone_path"
	fi
fi

# Register the repo + create a workspace. Tolerate "already exists" on a
# re-run after a sandbox wake so boot stays idempotent.
"$HELMOR_CLI" repo add "$clone_path" || true
"$HELMOR_CLI" workspace new --repo "$repo_name" || true

echo "helmor boot: repo '${repo_name}' cloned + registered; workspace created."
