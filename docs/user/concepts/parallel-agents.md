# Parallel agents

Helmor's whole premise: agents are fast, you are the bottleneck. The fix is
not a faster agent — it's running several and getting good at switching.

## The rhythm

1. **Fan out.** Create a workspace per task (**⌘N**) and dispatch each one.
   Isolation makes this safe — five agents in five worktrees can't conflict
   ([Workspaces](workspaces.md)).
2. **Rotate.** While agents work, you review. Move to whichever workspace
   needs you, read the diff, steer or approve, move on.
3. **Ship and archive.** Merged work leaves the sidebar; new tasks enter.

## Knowing where you're needed

The sidebar is your control tower:

- **Running** — the agent is mid-turn; nothing needed from you.
- **Needs input** — the agent asked a question or wants permission.
- **Unread** — finished while you were elsewhere.
- A **glowing border** means run scripts (dev server, tests) are active.

Desktop notifications (with optional sounds) fire when an agent finishes or
needs you — configurable in Settings → General.

## Switching fast

- **⌃Tab** — quick-switch overlay between recent workspaces (hold ⇧ to go
  backwards)
- **⌘⌥↑ / ⌘⌥↓** — previous / next workspace in the sidebar
- **⌘⇧F** — filter and sort the sidebar
- **⌘L** — jump focus straight to the composer

## Organizing the fleet

- **Group** the sidebar by repository or by status, or keep a flat list.
- **Status lanes** — assign workspaces *In Progress*, *Review*, *Done*,
  *Backlog*, or *Canceled* and group by status for a kanban-style view.
- **Pin** the workspaces you keep coming back to; **mark unread** anything you
  want to revisit; drag to reorder.

## Drive-by tasks

The **quick panel** (⇧⌥Space) is a small floating window for tasks that don't
deserve a context switch — fire off a prompt from anywhere, glance at the
response, and either dismiss it or open it fully in the main window.

## Dispatching from the terminal

Parallelism composes with your shell. The CLI can create workspaces and send
prompts without touching the GUI:

```bash
helmor workspace new --repo myapp
helmor send --workspace myapp/refactor-auth "Extract the session logic into its own module."
```

See [CLI & MCP](../reference/cli-and-mcp.md).

## How many is too many?

In practice the limit is your review bandwidth, not the machine. A good
starting shape: two or three substantive tasks plus a couple of small ones.
Plan mode helps you keep risky work cheap to supervise — let the agent propose
before it implements.
