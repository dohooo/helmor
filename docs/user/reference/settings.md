# Settings

Open settings with **⌘,**. Panels, from top to bottom:

## General

Defaults for new sessions and app-wide behavior:

- **Default model**, **default effort**, and default toggles for fast mode and
  permission behavior.
- **Notifications** — desktop notifications and sounds for when agents finish
  or need input.

## Appearance

- Theme (light / dark / system — quick-toggle with **⌘⌥T**), accent color,
  font, zoom level (**⌘+ / ⌘− / ⌘0**).
- Sidebar layout: grouping (flat, by repository, by status) and sort order.

## Models

Provider configuration:

- **Cursor** — API key; once set, Cursor models appear in the picker.
- **OpenCode** — connect providers and choose which models to expose
  (read from your `~/.config/opencode/opencode.jsonc`).
- **Custom Claude-compatible providers** — base URL + API key for any endpoint
  speaking the Claude API.

Claude Code and Codex sign-in is handled through their own login flows during
onboarding (or re-run from here). See
[Agents & models](../concepts/agents-and-models.md).

## Accounts

GitHub and GitLab accounts, via the bundled `gh`/`glab` CLIs. Multiple
accounts are supported; each repository binds to the account that has access.
Re-authenticate from here if a token expires — the login flow runs in an
embedded terminal.

## Repository

Per-repository configuration (also reachable from the sidebar):

- **Scripts** — setup / run / archive scripts, with an editor
  ([Configure your project](../get-started/configure-your-project.md))
- **Default branch**, **branch prefix**, **remote**
- **Auto-run setup** on workspace creation
- **Archive on merge**

## Shortcuts

Every keybinding in the app is rebindable, per scope (app, chat, composer,
editor, terminal), with conflict detection and a reset-to-defaults. The full
map: [Keyboard shortcuts](keyboard-shortcuts.md).

## App Updates

Current version, update channel status, manual *Check for updates*. Updates
download in the background and apply on restart.

## Local LLM

Manage the on-device models that power local features such as automatic
session titles. Downloads can be paused and resumed.

## Mobile companion *(experimental)*

Pair a phone to keep an eye on sessions away from your desk.

## Experimental

- **Command Line Tool** — install the `helmor` CLI to your PATH
  ([CLI & MCP](cli-and-mcp.md)).
- Other in-progress features, clearly labeled.
