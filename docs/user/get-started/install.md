# Install

## Download

Grab the latest release from
[github.com/dohooo/helmor/releases](https://github.com/dohooo/helmor/releases):

- **macOS** — DMG for Apple Silicon and Intel. Open the DMG and drag Helmor to
  Applications.
- **Windows** — x64 setup installer.

Everything Helmor needs is bundled inside the app: the agent CLIs
(Claude Code, Codex, and friends) and the GitHub/GitLab CLIs (`gh`, `glab`).
You do not need to install any of them separately.

## First launch

On first launch, Helmor walks you through a short onboarding:

1. **Connect GitHub or GitLab.** Helmor uses the bundled `gh`/`glab` CLIs and
   their standard login flow. If you are already signed in to `gh` on this
   machine, Helmor picks that up automatically; otherwise it opens an
   interactive sign-in right inside the app. Multiple accounts are supported —
   each repository remembers which account it belongs to.
2. **Sign in to an agent.** Use your existing Claude Code or Codex login, or
   enter an API key. You can add more providers later in
   [Settings → Models](../reference/settings.md). See
   [Agents & models](../concepts/agents-and-models.md) for what each provider
   needs.
3. **Add a repository.** Point Helmor at a local clone, or clone from a URL.
4. **Optional extras.** Install recommended skills and the `helmor`
   command-line tool.

That's it — you are ready for
[your first workspace](your-first-workspace.md).

## Where your data lives

Helmor stores everything under `~/helmor/`:

- `helmor.db` — the SQLite database (workspaces, sessions, settings)
- `workspaces/<repo>/<name>/` — one directory per workspace (a git worktree)
- `chats/` — scratch directories for chat-only workspaces
- `logs/` — application logs

Nothing is synced anywhere. See [Privacy](../security/privacy.md) for the full
picture.

## Updates

Helmor checks for updates automatically and installs them on restart. You can
trigger a check manually in **Settings → App Updates**. After an update, a
"What's new" toast summarizes the changes — full notes are in the
[GitHub releases](https://github.com/dohooo/helmor/releases).

## Installing the CLI

The `helmor` terminal command is optional but recommended:

**Settings → Experimental → Command Line Tool → Install**

This installs a small launcher (to `/usr/local/bin/helmor` on macOS, or
`%LOCALAPPDATA%\Helmor\bin\helmor.cmd` on Windows) that always points at your
installed app, so the CLI and the app never drift apart. On Windows, open a
new terminal afterwards so the updated `PATH` is picked up.

See [CLI & MCP](../reference/cli-and-mcp.md) for what you can do with it.
