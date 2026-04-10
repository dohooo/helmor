# Helmor

Brush version 1 of a local-first desktop app built with Tauri, React, Vite, and
Vitest.

## Scripts

- `pnpm install` installs dependencies.
- `pnpm run tauri dev` starts the desktop app in development mode.
- `pnpm run build` builds the frontend bundle.
- `pnpm run test` runs the current regression test suite.
- `pnpm run test:watch` starts Vitest in watch mode.

## CLI & MCP

See [docs/cli-and-mcp.md](docs/cli-and-mcp.md) for the standalone CLI and MCP server guide.

## Current Scope

This first brush intentionally keeps the app simple:

- one Tauri window
- one minimal React application shell
- one baseline test to lock the startup UI
