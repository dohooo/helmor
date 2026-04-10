# Helmor CLI & MCP Server

Helmor ships a standalone CLI binary (`helmor`) that manages workspaces, sessions, and repositories from the terminal — and doubles as an MCP server for AI-native tool integration.

## Install

### Development

```bash
pnpm run dev:cli:build                        # compile (debug)
pnpm run dev:cli:install                      # compile + copy to /usr/local/bin/helmor
```

The debug build reads `~/helmor-dev/` — same database as `pnpm run dev`.

### Settings UI

Open the desktop app → Settings → Experimental → **Command Line Tool** → Install.

## CLI Usage

```bash
helmor data info
helmor repo list
helmor repo add /path/to/repo
helmor workspace list
helmor workspace show helmor/earth            # human-readable ref
helmor workspace new --repo helmor
helmor session list --workspace helmor/earth
helmor session new --workspace helmor/earth
helmor send --workspace helmor/earth "Refactor the auth module"
```

`--json` on any command outputs machine-readable JSON. `--data-dir <path>` overrides the data directory.

### Workspace References

Most commands accept either a UUID or a `repo-name/directory-name` shorthand:

```bash
helmor workspace show 5508edf1-bc73-4c6e-9c3d-21de3eeb25be   # UUID
helmor workspace show ai-shipany-template/draco                 # shorthand
```

## MCP Server

Run `helmor mcp` to start a stdio MCP server implementing JSON-RPC 2.0.

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

### Register with Claude Code

```bash
claude mcp add helmor -- /usr/local/bin/helmor mcp
```

Verify: `claude mcp list`

### Register with Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Restart Claude Desktop.

### Register with Cursor

Edit `~/.cursor/mcp.json`:

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

### Dev Mode

Point to the debug binary instead:

```bash
claude mcp add helmor -- ./src-tauri/target/debug/helmor-cli mcp
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
