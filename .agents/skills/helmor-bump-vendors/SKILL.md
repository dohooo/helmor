---
name: helmor-bump-vendors
description: Bump or upgrade the pinned versions of Helmor's bundled agent CLIs, SDKs, and supporting binaries — Claude Code + claude-agent-sdk (lockstep), Codex, Cursor SDK, OpenCode, Kimi, Pi, and gh / glab / cloudflared / llama.cpp / Node. Encodes exactly which files to edit (`sidecar/package.json`, `sidecar/scripts/vendor-platform.ts`), how to source each version and compute its SHA256, the Claude SDK↔CLI lockstep rule, npm dist-tags caveats (latest vs next vs stable), the cross-arch (arm64+x64) SHA requirement, and the mandatory verification gates. Use whenever the user wants to upgrade / bump / update / refresh a bundled agent CLI or SDK version, check whether a vendor is behind latest, or run a dependency version sweep in the Helmor repo.
---

# Helmor Bump Vendors

Standardized procedure for upgrading the third-party agent CLIs, SDKs, and helper binaries
that Helmor pins and bundles. Goal: a correct, verified bump with no guesswork about *where*
versions live, *how* to source each SHA256, or *what* to run before declaring it done.

## The pin sites

Every bundled version is pinned in one (or both) of these files:

- **`sidecar/package.json`** — npm dependencies. Covers SDKs (imported in TS) and the
  npm-distributed CLIs whose native binary is staged from `node_modules`
  (`@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`).
- **`sidecar/scripts/vendor-platform.ts`** — version constants + per-version **SHA256 tables**
  for every *staged binary*. Source of truth for what gets bundled into the release.
- `sidecar/scripts/stage-vendor.ts` — staging *logic*. Only edit it when a vendor's archive
  **layout** changes (rare; see codex/cursor notes in `references/vendors.md`).

## Vendor classes (determine the change-set)

| Class | Vendors | What to edit | SHA256? |
|---|---|---|---|
| **A. npm SDK only** | `@anthropic-ai/claude-agent-sdk`, `@cursor/sdk`, `@opencode-ai/sdk`, `@earendil-works/pi-*` | `package.json` line | No — plain npm dep |
| **B. npm-distributed staged binary** | claude-code, codex, opencode | `package.json` line **+** SHA256 table key in `vendor-platform.ts` | Yes — from npm tarball |
| **C. GitHub-release staged binary** | kimi, gh, glab, cloudflared, llama.cpp, node | `<NAME>_VERSION` const **+** SHA256 table in `vendor-platform.ts` (NOT in `package.json`) | Yes — source varies |

Per-vendor exact pin location, SHA256 source, and gotchas live in **`references/vendors.md`** —
read the relevant section before editing.

## Workflow

1. **Scope.** Confirm which vendors to bump. For each, open `references/vendors.md` for its class,
   pin location, SHA source, and gotchas.
2. **Find the target version. Check LIVE — never trust memory; dist-tags flip within hours.**
   - npm: `bun -e 'console.log((await (await fetch("https://registry.npmjs.org/<pkg>")).json())["dist-tags"])'`
     Target `latest` (the stable channel). `next` is a prerelease — do **not** pin it unless the
     user explicitly asks. claude-code also publishes a conservative `stable` tag that *lags*
     (e.g. `2.1.179`); Helmor tracks `latest`, not `stable`.
   - GitHub-release vendors: check the repo's Releases (or `https://api.github.com/repos/<owner>/<repo>/releases`).
3. **Edit the pins** (`package.json` and/or the `_VERSION` const). Apply the **Claude lockstep rule**
   and any per-vendor gotcha from the reference.
4. **`cd sidecar && bun install`** — pulls the new versions. Sanity-check: resolved versions are
   correct, any *removed* deps dropped from `bun.lock`, transitive deps you rely on are still present.
5. **Compute + fill SHA256** for class B/C. Use `scripts/npm_vendor_sha.sh` for B; see the reference
   for C. **Both `arm64` and `x64` are mandatory** (see Critical rules).
6. **Run the verification gates** (below) — all must pass.
7. **Create release metadata.** Once the gates pass, invoke the **`/helmor-release`** skill to draft
   the changeset (and an in-app announcement if the bump warrants one). Don't skip this — a vendor
   bump is a user-visible change and needs a changeset. A routine bundled-agent refresh is typically
   a `patch` changeset with **no** announcement; the body should name the user-visible change (which
   agents moved to latest), not the internal cleanup (Pi removal, pin tidy-ups, doc fixes).
8. **Report**: current → target per vendor, breaking-change assessment, gate results, exact files
   touched, and the changeset created. Leave commit / PR to the user unless asked.

## Critical rules (the non-obvious parts that cause bad bumps)

- **Claude lockstep.** `@anthropic-ai/claude-agent-sdk@0.3.X` and `@anthropic-ai/claude-code@2.1.X`
  share patch `X` and ship together — **always bump both to the same X**. Verify: the SDK's
  `node_modules/@anthropic-ai/claude-agent-sdk/package.json` carries `claudeCodeVersion: "2.1.X"`.
  Only **claude-code** (the staged binary) needs a SHA256 entry; the agent-sdk is a plain npm dep.
- **Cross-arch SHA is mandatory.** Every class B/C SHA table needs **both `arm64` and `x64`**.
  CI cross-builds the x86_64 bundle on an arm64 runner. On a native-arch host the build uses
  `node_modules` directly and does **not** verify the SHA — so a wrong/missing `x64` entry passes
  locally but **breaks CI**. Always compute both from the tarballs.
- **dist-tags drift.** Re-check `latest` at bump time even if you "just looked" — a newer patch can
  be promoted from `next` to `latest` within hours.
- **SHA table = rolling history.** The tables keep a few recent version keys (cache is
  version-keyed, so old keys coexist harmlessly). Add the new key; keep the prior one. If you are
  *superseding an uncommitted entry you added this session*, replace it (don't stack) for a clean diff.
- **Layout-change watch.** Codex ships a self-describing `codex-package.json` descriptor; after a
  bump, diff it — a `layoutVersion` change or new field means `stage-vendor.ts` needs review. See
  `references/vendors.md` for codex, cursor (Node engines floor + phantom dep), and kimi (ACP
  protocol version) specifics.

## Verification gates (run in order; all must pass)

```bash
cd sidecar && bun install        # 1. installs targets; confirm versions + dropped deps in bun.lock
cd sidecar && bun run typecheck  # 2. catches SDK API breaks (removed/renamed exports) — main breaking-change detector
cd sidecar && bun test           # 3. sidecar unit tests
# 4. MANDATORY after ANY agent CLI/SDK bump — validates the stdout event-shape contract the Rust pipeline depends on:
cd src-tauri && cargo test --test pipeline_scenarios --test pipeline_fixtures --test pipeline_streams
cd sidecar && bun run build      # 5. full staging + compile; a wrong SHA256 hard-fails here (downloads + verifies kimi / cross-arch)
```

What each gate proves:
- **typecheck** is the real breaking-change detector for SDK bumps (removed/renamed exports, changed types).
- **cargo pipeline tests** replay *stored* fixtures, so they catch pipeline-code regressions — **not**
  new event shapes from a newer binary. For the latter, read the upstream changelog (focus on the
  stdout event JSON: codex `item/`,`turn/`,`thread/` methods; claude `SDKMessage`/stream blocks;
  opencode `message.part`; kimi ACP `session/update`) and capture fresh fixtures if the shape moved.
- **build** is the only gate that exercises SHA256 verification and the staging layout.

## Breaking-change diligence

Before pinning, read the upstream changelog/release notes across the current→target window. Most
agent-CLI patch bumps are additive; the risks that matter for Helmor are (a) SDK export/type changes
(typecheck catches these) and (b) stdout event-shape changes (the Rust pipeline contract). Tag each
notable change *affects Helmor* or *no impact* with reasoning, and surface it before bumping.

## Tools in this skill

- **`scripts/npm_vendor_sha.sh <claude-code|codex|opencode> <version>`** — downloads the darwin
  `arm64` + `x64` npm tarballs and prints their SHA256, ready to paste into the `vendor-platform.ts`
  table. (Class B only. Class A SDKs need no SHA; class C sources differ — see the reference.)
- **`references/vendors.md`** — exhaustive per-vendor map: integration mechanism, exact pin
  location, SHA256 source/recipe, gotchas, and post-bump steps.
