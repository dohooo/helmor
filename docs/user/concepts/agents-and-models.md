# Agents & models

Helmor is agent-agnostic: it orchestrates the agents you already use, with
the accounts you already have. All agent CLIs are bundled inside the app —
there is nothing to install, and Helmor never proxies your traffic through its
own servers.

## Supported agents

| Agent | Sign in with | Notes |
| --- | --- | --- |
| **Claude Code** | Your existing Claude Code login (Claude subscription) or an Anthropic API key | The default provider. Supports skills, MCP servers, extended thinking |
| **OpenAI Codex** | Your existing Codex login (ChatGPT) or an OpenAI API key | Supports goal tracking and skills |
| **Cursor** | Cursor API key (Settings → Models) | Cursor's agent models; the section appears once a key is set |
| **OpenCode** | Providers from your `~/.config/opencode/opencode.jsonc` | Bring any OpenCode-compatible provider/model |

If you are already signed in to Claude Code or Codex on this machine, Helmor
picks the login up automatically. Otherwise, onboarding (or Settings) walks
you through signing in.

You can also add **custom Claude-compatible providers** — any endpoint that
speaks the Claude API, with its own base URL and key — in Settings → Models.
They appear in the model picker alongside the official models.

## Picking a model

The model picker lives in the composer toolbar (**⌥P**). Models are grouped by
provider, and your choice is per-session — different sessions, different
models, even within one workspace. A default model for new sessions is set in
**Settings → General**.

## Effort levels

Most models expose an **effort** dropdown next to the model picker: `low`,
`medium`, `high`, `xhigh`, up to `max` depending on the model. Higher effort
means deeper reasoning and longer runs; lower effort is snappier for mechanical
tasks. Helmor remembers your choice per session.

## Modes

- **Plan mode** (⇧Tab) — the agent reads and proposes; it does not modify
  files. Review the plan, then approve it to switch into implementation. Great
  for anything you'd want to see an approach for first.
- **Fast mode** — on supported models, trades some thoroughness for
  significantly faster turns. Good for small, well-scoped edits.
- **Terminal mode** (⌘⇧T) — sends your prompt to the agent's own terminal UI
  inside a built-in terminal, instead of a GUI turn. Useful for agent-native
  flows that only exist in the TUI.

Permission behavior for new sessions (how much the agent may do without
asking) is configurable in Settings → General, and per message from the CLI
(`--permission-mode plan|auto|yolo|default`).

## Skills and slash commands

Type `/` in the composer to browse what the current agent can do:

- **Claude Code** exposes its built-in commands and any skills installed in
  your project or user scope.
- **Codex and Cursor** discover skills from `.agents/skills`,
  `.claude/skills`, `.cursor/skills`, and `.codex/skills` directories (project
  and user scope).

## MCP servers

Claude Code sessions load the MCP servers you have configured for the project
(and your user-scope servers), exactly as they would in the terminal. Tools
that ask questions or request input pop a form right in the conversation.

Helmor itself can also *be* an MCP server for other tools — see
[CLI & MCP](../reference/cli-and-mcp.md).

## Local models

Helmor bundles a llama.cpp runtime used for small on-device features (like
automatic session titles), with models managed under **Settings → Local LLM**.
Your prompts to coding agents always go to the provider you selected — never
to a third party.

## Network and proxies

Agent processes inherit your proxy configuration: Helmor can follow the macOS
system proxy or use a custom HTTP/SOCKS5 proxy (**Settings**). This applies to
Claude Code, Codex, and Cursor traffic alike.
