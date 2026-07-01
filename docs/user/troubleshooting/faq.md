# FAQ

### Is Helmor free?

The app is open source (Apache 2.0) and free. You pay your model providers
directly — Claude/Anthropic, OpenAI, Cursor — through the subscriptions or API
keys you already have.

### Do I need Claude Code / Codex / gh installed first?

No. Helmor bundles the agent CLIs and the GitHub/GitLab CLIs inside the app.
You only need your accounts; if you're already signed in to these tools on
your machine, Helmor picks the logins up automatically.

### Which platforms are supported?

macOS (Apple Silicon and Intel) and Windows (x64).

### Where is my data?

`~/helmor/` — a SQLite database plus one directory per workspace. Nothing is
synced anywhere. See [Privacy](../security/privacy.md).

### Can several agents really work on the same repo at once?

Yes — that's the point. Each workspace is an isolated git worktree with its
own branch and directory, so parallel agents can't interfere with each other
or with your own checkout. See [Workspaces](../concepts/workspaces.md).

### Does Helmor work with GitLab?

Yes. GitHub and GitLab are both supported, including PR/MR creation and merge,
via the bundled `gh` and `glab` CLIs.

### What happens to my branch when I archive a workspace?

The worktree directory is removed and the conversation is kept. The branch is
deleted only if Helmor auto-generated it; branches you picked yourself are
preserved. Archived workspaces can be restored later.

### Can I use my own editor instead of the built-in one?

Yes. A workspace is a plain git checkout — **⌘O** opens it in your external
editor, and Helmor picks up changes made by any tool.

### Does Helmor work offline?

The app and your history do — browsing, diffs, editing, terminals all work
offline. Agents need network access to reach their providers; git/PR actions
need your remotes.

### Can I drive Helmor without the GUI?

Yes — the `helmor` CLI covers repositories, workspaces, sessions, prompts, and
ship actions, and `helmor mcp` exposes Helmor to other agents over MCP. See
[CLI & MCP](../reference/cli-and-mcp.md).

### A keyboard shortcut clashes with another app

Every binding is rebindable in **Settings → Shortcuts**, with conflict
detection.

### Where do I ask questions or report bugs?

The [Discord](https://discord.gg/ukyyuNfnDp), the feedback button at the
bottom of Helmor's sidebar, or
[GitHub issues](https://github.com/dohooo/helmor/issues).
