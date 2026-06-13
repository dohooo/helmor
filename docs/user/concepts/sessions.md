# Sessions

A session is one conversation with one agent. Workspaces hold sessions as
tabs, so a single task can have several threads — an implementation session, a
review session, a "explain this subsystem" session — each with its own model
and settings.

## Tabs

- **⌘T** — new session in the current workspace
- **⌘W** — close the current session
- **⌘⇧R** — reopen the last closed session
- **⌘⌥←/→** — switch between sessions

Titles are generated automatically from the conversation (you can rename via
double-click). Sessions persist in your local database — closing a tab hides
it, it never deletes history.

## Streaming and steering

Agent output streams live: text, tool calls, file edits, and (where the model
supports it) reasoning. While a turn is running you have three options:

- **Watch** — or don't. The sidebar marks workspaces that need attention.
- **Steer** — type a message and hit **Send** (the button reads *Steer* during
  a turn). Your message is injected into the running turn, redirecting the
  agent without restarting it.
- **Queue** — **⌘Enter** queues the message to send after the current turn
  finishes. Queued prompts appear above the composer, where you can edit,
  remove, or promote them to steer immediately.

**Stop** aborts the turn cleanly; the session records that it was stopped and
remains usable.

## Questions and permissions

When an agent needs something from you — a clarifying question, a permission
to proceed, a plan approval — the request renders as an interactive panel in
the conversation. Workspaces waiting on you are flagged in the sidebar, and
desktop notifications can alert you (Settings → General).

## Context usage

The donut ring in the composer shows how full the model's context window is.
Hover for a breakdown. When a long-running session gets close to the limit,
that's your cue to wrap up or start a fresh session.

## Resume

Sessions survive restarts. If the app quits mid-turn, the conversation is
intact and you can continue where things left off — the underlying provider
session is resumed rather than replayed.

## Several sessions, one workspace

Sessions in a workspace share the same working directory, so they see each
other's file changes. Use this deliberately: a common pattern is one session
implementing while a second session reviews the diff or writes tests. For
truly independent tasks, prefer separate workspaces — that's what isolation is
for ([Workspaces](workspaces.md)).
