# Changesets

This repository uses Changesets to produce user-facing release notes and keep
the application version in sync across:

- `package.json`
- `src-tauri/Cargo.toml`
- `src-tauri/tauri.conf.json`

Create a changeset for user-visible changes with:

```bash
bun run changeset
```

Merge the generated release PR when the next Helmor release is ready, then run
the macOS publish workflow.
