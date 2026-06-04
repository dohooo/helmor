# Stack spec — format & canonical diagram

The `stacked-pr` skill renders its diagram from a JSON **stack spec** via
`scripts/render_stack.py`. The renderer derives all column widths from the
data, so every stack comes out in the same shape. Do not hand-draw the
diagram — always render through the script so output is byte-for-byte
consistent.

## Spec shape

Layers are ordered **tip → root** — the newest PR (top of the stack) first,
the base-most PR last.

```json
{
  "name": "dark-mode",
  "repo": "helmor/uranus",
  "base": "main",
  "layers": [
    {"pr": "483", "title": "feat: dark mode toggle",  "state": "draft",  "ws": "dark-mode-ui"},
    {"pr": "482", "title": "feat: persist theme pref", "state": "open",   "ws": "dark-mode-api"},
    {"pr": "481", "title": "feat: add theme column",   "state": "merged", "ws": "dark-mode-schema"}
  ]
}
```

| Field        | Meaning |
| ------------ | ------- |
| `name`       | Short stack name (e.g. the feature). |
| `repo`       | `owner/name` slug, shown in the header. |
| `base`       | The branch the bottom of the stack targets (usually `main`). |
| `layers[]`   | Ordered tip → root. |
| `layers[].pr`    | PR number as a string. Empty/omitted = no PR opened yet (lazy growth) → renders as `—`. |
| `layers[].title` | The PR / commit title. |
| `layers[].state` | One of `merged` · `open` · `draft` · `closed` · `none`. |
| `layers[].ws`    | The Helmor workspace (directory) name for this layer. |

The `base ◂` pointer for each layer is **derived**: it points at the PR of the
layer immediately below, and the bottom layer points at `base`. The `← HEAD`
marker is always on `layers[0]` (the tip).

## State glyphs (legend)

| Glyph | State |
| ----- | ----- |
| `✓`   | merged |
| `◉`   | open or draft (has a live PR) |
| `✕`   | closed |
| `○`   | no PR opened yet |

## Canonical output (style A)

Running the spec above produces exactly:

```text
stack: dark-mode · helmor/uranus · 3 PRs

◉ #483  feat: dark mode toggle      draft    ← HEAD
│  └ ws: dark-mode-ui      base ◂ #482
│
◉ #482  feat: persist theme pref    open
│  └ ws: dark-mode-api     base ◂ #481
│
✓ #481  feat: add theme column      merged
│  └ ws: dark-mode-schema  base ◂ main
┴ main
```

Read it top-down: the tip (`#483`, newest) is on top and sorts into the
sidebar normally; each lower PR is the base of the one above it; `main` is the
stack's foundation at the bottom. This is the textual twin of how the Helmor
sidebar groups the stack's workspaces.
