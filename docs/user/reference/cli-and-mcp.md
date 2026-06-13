# CLI & MCP

Helmor ships a companion CLI that works against the same local database as the
desktop app — you can use both at the same time. It also runs as an MCP
server, so other agents and tools can drive Helmor.

## Installing

**Settings → Experimental → Command Line Tool → Install.** This puts a
`helmor` launcher on your PATH that always points at the installed app, so CLI
and app versions never drift. (On Windows, open a new terminal afterwards.)

## The essentials

```bash
helmor repo list                       # registered repositories
helmor repo add /path/to/repo          # link a local clone

helmor workspace list                  # active workspaces, grouped by status
helmor workspace new --repo myapp      # create a workspace
helmor workspace show myapp/feature-x  # details for one workspace
helmor workspace status myapp/feature-x  # ahead/behind, conflicts, push state

helmor send --workspace myapp/feature-x "Add a test for the parser edge case."
```

Workspaces are addressed by UUID **or** the `repo-name/directory-name`
shorthand — the shorthand is what you'll actually use.

### Sending prompts

`helmor send` dispatches to the workspace's active session (or a specific one
with `--session`):

```bash
helmor send --workspace myapp/feature-x --plan "Sketch the refactor first."
helmor send --workspace myapp/feature-x --model <model-id> "…"
cat task.md | helmor send --workspace myapp/feature-x -
```

- `--plan` is shorthand for `--permission-mode plan`; full options are
  `plan`, `auto`, `yolo`, and `default`.
- `helmor models` lists the model IDs you can pass to `--model`.
- `-` reads the prompt from stdin — handy for long or generated prompts.

### The ship flow

```bash
helmor workspace sync myapp/feature-x        # pull latest from target branch
helmor workspace push myapp/feature-x        # push the branch
helmor workspace run-action myapp/feature-x  # dispatch a ship action
helmor workspace stack myapp/feature-x       # view the PR stack
helmor workspace archive myapp/feature-x
helmor github                                # auth, PR lookup, merge
```

### Scripting

Every command accepts:

- `--json` — machine-readable output
- `--quiet` — IDs only (or nothing)
- `--data-dir <path>` — point at a different data directory

```bash
helmor workspace list --json | jq '.[].name'
```

Shell completions: `helmor completions <shell>`.

Other useful subcommands: `helmor session` (inspect conversations),
`helmor files` (read/write workspace files), `helmor scripts show` (effective
setup/run/archive scripts), `helmor settings`, `helmor data info`, and
`helmor conductor` (migration). Each has `--help` with examples.

## MCP server

`helmor mcp` runs Helmor as an MCP (Model Context Protocol) server over stdio,
exposing read-only tools for repositories, workspaces, sessions, and settings.
Register it with any MCP client — for example, with Claude Code:

```bash
claude mcp add helmor -- helmor mcp
```

Now an agent anywhere on your machine can list your workspaces, read session
history, and check workspace status — useful for building your own
orchestration on top of Helmor, or letting one agent supervise the others.
