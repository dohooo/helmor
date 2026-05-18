# Helmor CLI Top-Level Help

Captured from `helmor --help`.

```text
Remote-control Helmor from the terminal. Works against the same SQLite database the desktop app uses — run commands even while the app is running.

Usage: helmor [OPTIONS] <COMMAND>

Commands:
  data         Data directory, database, and mode info
  settings     App settings stored in `settings` table
  repo         Repository registration and configuration
  workspace    Workspace CRUD, branching, syncing, archiving
  session      Session CRUD and inspection
  files        File listing, reading, writing, staging (editor surface)
  send         Send a prompt to an AI agent
  models       List available AI models
  github       GitHub integration — auth, PR lookup, merge
  scripts      Inspect repo-level setup/run/archive scripts
  conductor    Migrate from Helmor v1 (Conductor)
  completions  Shell completion scripts
  cli-status   Report whether the current Helmor CLI entrypoint is installed to PATH and which data mode it uses
  quit         Ask a running Helmor app to quit (noop when it isn't running)
  mcp          Run as an MCP (Model Context Protocol) server over stdio
  help         Print this message or the help of the given subcommand(s)

Options:
      --json
          Emit JSON instead of human-friendly text

      --quiet
          Reduce output to IDs / nothing. Useful for scripting

      --data-dir <DIR>
          Override the data directory (default: ~/helmor or ~/helmor-dev)

  -h, --help
          Print help (see a summary with '-h')

  -V, --version
          Print version
```
