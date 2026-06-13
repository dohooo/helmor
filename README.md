<p align="center">
  <img src="src/assets/helmor-logo-light.png" alt="Helmor logo" width="120" />
</p>

<h1 align="center">Helmor</h1>

<p align="center">
  The local-first workbench for orchestrating coding agents.
</p>

<p align="center">
  <a href="https://github.com/dohooo/helmor/releases"><img src="https://img.shields.io/github/v/release/dohooo/helmor?style=flat&label=Release&color=0A7CFF" alt="Latest release" /></a>
  <a href="https://discord.gg/ukyyuNfnDp"><img src="https://img.shields.io/discord/1499667625267957920?style=flat&logo=discord&label=Discord&color=5865F2" alt="Discord" /></a>
  <a href="docs/user/README.md"><img src="https://img.shields.io/badge/Docs-User_Guide-8A2BE2" alt="User docs" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-3DA639" alt="License: Apache 2.0" /></a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="src/assets/helmor-screenshot-dark.png" />
  <img src="src/assets/helmor-screenshot-light.png" alt="Helmor screenshot" width="100%" />
</picture>

> AI made coding faster. Helmor is about finishing the rest of the loop —
> orchestrating, reviewing, testing, merging, and actually shipping software.

Helmor runs many coding agents in parallel, each inside its own isolated git
workspace, and gives you one place to steer them all: conversation, diffs, a
real editor, terminals, run scripts, and one-click PR actions. Everything is
stored in a local SQLite database on your machine.

## Highlights

- **Isolated workspaces** — every task gets its own git worktree and branch.
  Agents never trample each other's changes, and your `main` stays clean.
- **Bring your own agents** — Claude Code, OpenAI Codex, Cursor, and OpenCode
  side by side, using your existing logins and API keys. Pick the model,
  effort level, plan mode, or fast mode per message.
- **Steer mid-flight** — watch output stream live, inject follow-ups while the
  agent is still working, queue prompts, paste images, mention files with `@`.
- **Review without leaving** — changed files, side-by-side diffs, a Monaco
  editor, and built-in terminals sit right next to the conversation.
- **Ship from one button** — Create PR, Commit & Push, Pull Latest, Merge,
  Fix CI, Resolve Conflicts. Stacked PRs included. GitHub and GitLab.
- **Local-first** — your code, sessions, and credentials never leave your
  machine, except for the agent API calls you choose to make.
- **Scriptable** — a full `helmor` CLI and a built-in MCP server, so your
  terminal — or another agent — can drive Helmor too.

## Install

[**Download Helmor** →](https://github.com/dohooo/helmor/releases)

- **macOS** — Apple Silicon and Intel (DMG)
- **Windows** — x64 setup installer

On first launch, Helmor walks you through connecting GitHub or GitLab and
signing in to your first agent. Agent CLIs are bundled — there is nothing else
to install. See the [install guide](docs/user/get-started/install.md) for
details.

## How it works

1. **Add a repository** — link a local clone, or clone from a URL.
2. **Create a workspace** — Helmor makes a fresh git worktree and branch under
   `~/helmor/workspaces/` and runs your project's setup script.
3. **Prompt an agent** — choose a model, describe the task, and move on to the
   next workspace while it runs.
4. **Review and ship** — read the diff, run your tests, then create and merge
   the PR from the inspector.

Repeat in parallel. Each workspace is fully independent, so five agents can
work on five tasks in the same repository at once.

## Documentation

The full user guide lives in [`docs/user/`](docs/user/README.md):

- [Introduction](docs/user/get-started/introduction.md) · [Install](docs/user/get-started/install.md) · [Your first workspace](docs/user/get-started/your-first-workspace.md) · [Configure your project](docs/user/get-started/configure-your-project.md)
- Concepts: [Workspaces](docs/user/concepts/workspaces.md) · [Agents & models](docs/user/concepts/agents-and-models.md) · [Sessions](docs/user/concepts/sessions.md) · [Parallel agents](docs/user/concepts/parallel-agents.md) · [Stacked PRs](docs/user/concepts/stacked-prs.md)
- Reference: [Composer](docs/user/reference/composer.md) · [Review & ship](docs/user/reference/review-and-ship.md) · [Editor](docs/user/reference/editor.md) · [Settings](docs/user/reference/settings.md) · [Keyboard shortcuts](docs/user/reference/keyboard-shortcuts.md) · [CLI & MCP](docs/user/reference/cli-and-mcp.md)
- [Privacy](docs/user/security/privacy.md) · [FAQ](docs/user/troubleshooting/faq.md) · [Troubleshooting](docs/user/troubleshooting/troubleshooting.md)

## CLI

Helmor ships a companion CLI that works against the same local database as the
app — even while the app is running:

```bash
helmor workspace new --repo myapp
helmor send --workspace myapp/feature-x "Add a test for the parser edge case."
helmor workspace status myapp/feature-x
```

`helmor mcp` exposes the same surface as an MCP server over stdio, so other
agents and tools can operate Helmor. See [CLI & MCP](docs/user/reference/cli-and-mcp.md).

## Building from source

Prerequisites: [Bun](https://bun.sh) 1.3+, a stable [Rust](https://rustup.rs)
toolchain, and platform build tools (Xcode Command Line Tools on macOS). A Nix
flake is also available — see [NIX_SETUP.md](NIX_SETUP.md).

```bash
bun install        # installs frontend + sidecar dependencies
bun run dev        # full desktop app in development mode
bun run test       # frontend, sidecar, and Rust test suites
```

Architecture notes for contributors (and their agents) live in
[AGENTS.md](AGENTS.md).

## Community

- [Discord](https://discord.gg/ukyyuNfnDp) — questions, feedback, release chat
- [GitHub Issues](https://github.com/dohooo/helmor/issues) — bugs and feature requests
- Or use the feedback button at the bottom of Helmor's sidebar

## License

[Apache 2.0](./LICENSE)
