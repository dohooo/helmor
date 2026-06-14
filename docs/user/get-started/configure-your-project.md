# Configure your project

A new workspace is a fresh checkout. To make it instantly productive —
dependencies installed, env files in place, dev server one keystroke away —
add a `helmor.json` to your repository root.

## `helmor.json`

```json
{
	"scripts": {
		"setup": "cp \"$HELMOR_ROOT_PATH/.env.local\" \"$HELMOR_WORKSPACE_PATH/.env.local\"\nbun install",
		"run": [
			{
				"name": "Dev",
				"command": "bun run dev",
				"stopCommand": "",
				"mode": "non-concurrent"
			},
			{
				"name": "Tests",
				"command": "bun run test",
				"stopCommand": "",
				"mode": "non-concurrent"
			}
		],
		"archive": ""
	}
}
```

### `setup`

A shell script that runs once when a workspace is created (and can be re-run
from the workspace at any time). Typical jobs:

- install dependencies (`bun install`, `npm ci`, `cargo fetch`, …)
- copy untracked files from your main clone — `.env.local`, local
  certificates, build caches

Multi-line scripts are fine; the whole string runs in your `$SHELL`.

### `run`

An array of named actions that appear in the workspace's scripts panel
(**⌘J**) — dev servers, test suites, builds. Each action has:

| Field | Meaning |
| --- | --- |
| `name` | Label shown in the UI |
| `command` | Shell command to run |
| `stopCommand` | Optional graceful-stop command; otherwise Helmor terminates the process |
| `mode` | `non-concurrent` actions stop the previous run before starting again |

Run the selected action with **⌘R**. Output streams into the panel with full
color support, and the sidebar shows a glow on workspaces with scripts
running.

### `archive`

An optional script that runs just before a workspace is archived — for
cleanup like stopping containers or releasing ports. Failures never block the
archive.

## Environment variables

Every script runs with these variables set:

| Variable | Value |
| --- | --- |
| `HELMOR_ROOT_PATH` | Path to your original clone of the repository |
| `HELMOR_WORKSPACE_PATH` | Path to the workspace's worktree |
| `HELMOR_WORKSPACE_NAME` | The workspace's directory name |
| `HELMOR_DEFAULT_BRANCH` | The repository's default branch |

The `setup` example above uses `HELMOR_ROOT_PATH` to copy untracked files from
your main clone into the new worktree — the standard trick for `.env` files
that aren't in git.

## Where the file is read from

Helmor looks for `helmor.json` in the **workspace directory first**, then
falls back to the **repository root**. That means a branch can ship its own
script changes, and they take effect in workspaces created from it.

You can also edit scripts without touching the file at all:
**Settings → Repository** has a script editor per repository.

## Per-repository settings

Alongside scripts, each repository has a few knobs (in Settings, or via the
sidebar's right-click menu):

- **Default branch** — what new workspaces target (auto-detected).
- **Branch prefix** — auto-generated branches are named
  `<prefix>/<workspace-name>`; use the default or set a custom prefix.
- **Remote** — which remote to push to and fetch from (usually `origin`).
- **Auto-run setup** — whether the setup script runs automatically on
  workspace creation (on by default).
- **Archive on merge** — automatically archive a workspace once its PR
  merges.

## Checking the effective configuration

From the terminal:

```bash
helmor scripts show --workspace <repo>/<workspace>
```

shows exactly which setup/run/archive scripts a workspace resolved to.
