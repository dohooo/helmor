# Introduction

Helmor is a desktop app for people who work *with* coding agents rather than
just chatting with one. It runs Claude Code, OpenAI Codex, Cursor, and
OpenCode side by side, gives each task its own isolated git workspace, and
keeps the whole loop — prompt, review, test, merge — in a single window.

## The problem it solves

A single agent in a single terminal is a queue: you wait, you review, you
start the next thing. Agents are fast enough now that *you* become the
bottleneck.

Helmor turns that queue into a fleet:

- **Each task gets its own workspace.** A workspace is a real git worktree
  with its own branch and directory. Five agents can work on five tasks in the
  same repository without ever touching each other's files — or your `main`.
- **You stay in the review seat.** While one agent works, you review another's
  diff, run its tests, and ship its PR. Status indicators in the sidebar tell
  you which workspaces need you.
- **Everything is local.** Workspaces, sessions, and settings live in a SQLite
  database and plain directories under `~/helmor/` on your machine. The only
  network traffic is the agent API calls and git operations you initiate, with
  your own credentials.

## A tour of the window

```
┌────────────┬──────────────────────────────┬────────────────┐
│  Sidebar   │       Conversation           │   Inspector    │
│            │                              │                │
│ Workspaces │  Agent messages, tool calls, │  Changed files │
│ grouped by │  diffs, reasoning, streaming │  Diff viewer   │
│ repo or    │                              │  Git actions   │
│ status     ├──────────────────────────────┤  Terminals     │
│            │       Composer               │  Run scripts   │
│            │  Prompt input + model picker │                │
└────────────┴──────────────────────────────┴────────────────┘
```

- **Sidebar** — your fleet. Every workspace, grouped and sorted how you like,
  with dots for *running*, *needs input*, and *unread*.
- **Conversation** — the active session with an agent. Sessions are tabs; a
  workspace can hold several.
- **Composer** — where you type. File mentions, slash commands, images, model
  and effort pickers, plan mode, and a queue for follow-up prompts.
- **Inspector** — the shipping side: changed files, diffs, one-click git/PR
  actions, terminals, and your project's run scripts.

There is also a built-in [editor](../reference/editor.md) for when you want to
touch the code yourself, and a floating quick panel for drive-by tasks.

## Core ideas in 30 seconds

1. **Workspace = task.** Create one per thing you want done. Archive it when
   it merges. ([Workspaces](../concepts/workspaces.md))
2. **Agents are pluggable.** Use whichever provider and model fits the task,
   per message, with your existing accounts.
   ([Agents & models](../concepts/agents-and-models.md))
3. **Shipping is part of the loop.** Create PR, Fix CI, Resolve Conflicts, and
   Merge are buttons, not chores. ([Review & ship](../reference/review-and-ship.md))

## Where to go next

- [Install Helmor](install.md)
- [Your first workspace](your-first-workspace.md) — a 10-minute walkthrough
- [Configure your project](configure-your-project.md) — make workspaces
  self-sufficient with setup and run scripts
