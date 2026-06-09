# Helmor CLI & MCP Server

Helmor ships a companion CLI inside the desktop app bundle. Release builds
install `helmor`; debug builds install `helmor-dev`. The terminal entrypoint
always points at the currently installed desktop app so CLI and desktop
versions stay aligned.

## Install

### Settings UI

Open the desktop app → Settings → Experimental → **Command Line Tool** → Install.
This installs a managed launcher to the app bundle's `helmor-cli`:

- macOS release: `/usr/local/bin/helmor`
- macOS debug: `/usr/local/bin/helmor-dev`
- Windows release: `%LOCALAPPDATA%\Helmor\bin\helmor.cmd`
- Windows debug: `%LOCALAPPDATA%\Helmor\bin\helmor-dev.cmd`

On Windows, open a new terminal after installing so the updated user `PATH` is visible.

### Development

```bash
bun run dev:cli:build
./src-tauri/target/debug/helmor-cli cli-status
bun run dev:cli:install
helmor-dev cli-status
```

The debug build reads `~/helmor-dev/` — same database as `bun run dev`.

## CLI Usage

```bash
helmor data info
helmor repo list
helmor repo add /path/to/repo
helmor workspace list
helmor workspace show helmor/earth            # human-readable ref
helmor workspace new --repo helmor
helmor workspace stack helmor/earth           # show PR stack for a workspace
helmor session list --workspace helmor/earth
helmor session new --workspace helmor/earth
helmor send --workspace helmor/earth "Refactor the auth module"
```

Debug builds use the same commands under `helmor-dev`.

`--json` on any command outputs machine-readable JSON. `--data-dir <path>` overrides the data directory.

### Workspace References

Most commands accept either a UUID or a `repo-name/directory-name` shorthand:

```bash
helmor workspace show 5508edf1-bc73-4c6e-9c3d-21de3eeb25be   # UUID
helmor workspace show ai-shipany-template/draco                 # shorthand
```

## MCP Server

Run `helmor mcp` (or `helmor-dev mcp` in debug) to start a stdio MCP server implementing JSON-RPC 2.0.

### Exposed Tools

| Tool | Description |
|------|-------------|
| `helmor_data_info` | Data directory and build mode |
| `helmor_repo_list` | List repositories |
| `helmor_repo_add` | Register a local Git repo |
| `helmor_workspace_list` | List workspaces by status |
| `helmor_workspace_show` | Workspace details |
| `helmor_workspace_create` | Create workspace |
| `helmor_session_list` | List sessions |
| `helmor_session_create` | Create session |
| `helmor_send` | Send prompt to AI agent |

## Agent Commands

Helmor agents understand special commands you can send through `helmor send` or directly in the UI:

### Stacked PR Workflow

Helmor supports building a large change as a **stack of small, dependent PRs** — one workspace = one branch = one PR, linked by `parentWorkspaceId`. Each PR builds on the one below instead of all branching from `main`, keeping every PR small and reviewable while you keep moving.

The agent provides three commands for stacked PR workflows:

- **`/helmor-cli stack`** — Plan and build a large change as a stack of dependent PRs, built one layer at a time. The workspace you start from becomes the stack's base (no throwaway launchpad).
- **`/helmor-cli break`** — Split a change you've *already written* into a stack, confirming the slicing granularity with you first. The starting workspace becomes the root.
- **`/helmor-cli restack`** — Re-sync a stack after a lower layer changes or merges. Also triggered by the composer's **Restack** button.

**Stack structure:**
- Each layer is a workspace with its own branch
- The sidebar groups stack workspaces together (tip on top → base at bottom) with connector lines
- A stacked workspace's panel header shows a clickable parent-workspace chip instead of a raw target-branch name
- `helmor workspace stack <ref>` displays the full PR stack chain

## CLI Commands

### Workspace Commands

#### helmor workspace stack <ref>

Display a workspace's PR stack — shows the whole chain of dependent workspaces from root to tip.

Options:
- `--json` — Output machine-readable JSON format matching the render_stack.py input spec

Example:
```bash
helmor workspace stack helmor/earth
helmor workspace stack helmor/earth --json | python3 scripts/render_stack.py -
```

#### helmor workspace new

Create a new workspace, either from a repository or as a stacked workspace on top of an existing workspace.

Syntax:
```bash
helmor workspace new [--repo <repo>] [--parent <workspace>]
```

Either `--repo` OR `--parent` is required:
- **`--repo <repo>`** — Create a workspace from a repository (for starting fresh)
- **`--parent <workspace-ref>`** — Create a stacked workspace that builds on top of an existing workspace (for stacked PRs). Records the parent workspace ID and sets the child's target branch to the parent's branch.

Examples:
```bash
# Start fresh from a repository
helmor workspace new --repo helmor

# Create a stacked workspace for dependent PRs
helmor workspace new --parent helmor/earth
```

### Register with Claude Code

macOS:

```bash
claude mcp add helmor -- /usr/local/bin/helmor mcp
```

Windows:

```powershell
claude mcp add helmor -- helmor mcp
```

Verify: `claude mcp list`

### Register with Claude Desktop

macOS: edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "helmor": {
      "command": "/usr/local/bin/helmor",
      "args": ["mcp"]
    }
  }
}
```

Windows: edit Claude Desktop's `claude_desktop_config.json` and use either `helmor`
after restarting Claude Desktop, or the absolute `helmor.cmd` path under
`%LOCALAPPDATA%\Helmor\bin`.

Restart Claude Desktop after changing the config.

### Register with Cursor

macOS: edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "helmor": {
      "command": "/usr/local/bin/helmor",
      "args": ["mcp"]
    }
  }
}
```

Windows: use `helmor` after restarting Cursor, or the absolute `helmor.cmd`
path under `%LOCALAPPDATA%\Helmor\bin`.

### Dev Mode

Use the debug entrypoint instead:

macOS:

```bash
claude mcp add helmor-dev -- /usr/local/bin/helmor-dev mcp
```

Windows:

```powershell
claude mcp add helmor-dev -- helmor-dev mcp
```

## Testing the MCP Server

### MCP Inspector (Web UI)

```bash
npx @modelcontextprotocol/inspector -- ./src-tauri/target/debug/helmor-cli mcp
```

Opens a browser UI to browse tools, invoke them, and inspect protocol traffic.

### Terminal Inspector

```bash
npx @wong2/mcp-cli -- ./src-tauri/target/debug/helmor-cli mcp
```

### Manual (pipe JSON-RPC)

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| ./src-tauri/target/debug/helmor-cli mcp
```
