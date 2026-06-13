# Privacy

Helmor is local-first by design. There is no Helmor cloud, no account to
create, and no server your code passes through.

## What stays on your machine

Everything Helmor manages lives under `~/helmor/`:

| Path | Contents |
| --- | --- |
| `helmor.db` | SQLite database: repositories, workspaces, sessions, full conversation history, settings |
| `workspaces/` | Workspace worktrees — your code |
| `chats/` | Scratch directories for chat-only workspaces |
| `logs/` | Application logs (JSONL) |
| `cache/` | Avatars, pasted images, UI caches |
| `local-llm/` | Downloaded on-device model files |

Conversation history is never uploaded. Settings are never synced. Deleting
`~/helmor/` removes everything Helmor knows (your repositories' original
clones are untouched — Helmor never moves or modifies them).

## What leaves your machine, and when

Only traffic you initiate, with your own credentials:

- **Agent API calls** — your prompts, and the file contents the agent chooses
  to read, go to the provider of the model you selected (Anthropic, OpenAI,
  Cursor, or your OpenCode/custom provider endpoints). Helmor does not proxy
  or inspect this traffic; the agent CLIs talk to their providers directly,
  authenticated by your login or API key.
- **Git operations** — fetch, push, clone, against your repository's remotes.
- **GitHub / GitLab API calls** — PR status, checks, create/merge, using
  tokens from your `gh`/`glab` logins. Tokens are managed by those CLIs, not
  copied into Helmor's database.
- **Update checks** — the app checks GitHub releases for new versions.
- **Feedback** — only if you use the feedback button, and only what you type
  there.

There is no analytics pipeline collecting your code or conversations.

## Credentials

Helmor does not have its own credential store for agents and forges — it
reuses the standard ones:

- Claude Code and Codex logins live where those CLIs keep them.
- `gh` / `glab` tokens live in those CLIs' own config/keychain.
- Keys you enter in Helmor settings (e.g. a Cursor API key, custom provider
  keys) are stored locally in your settings database.

## Local models

Features powered by the bundled local LLM (such as automatic session titles)
run entirely on-device.

## Taking your data with you

It's a SQLite file and plain directories. Back up `~/helmor/`, move it to a
new machine, or point Helmor elsewhere with the `HELMOR_DATA_DIR` environment
variable. The CLI (`helmor data info`) shows exactly where everything is.
