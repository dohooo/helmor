#!/usr/bin/env python3
"""Deterministic renderer for the Helmor stacked-PR diagram (canonical style A).

The stacked-pr skill builds a JSON "stack spec" and pipes it through this
script so the diagram is byte-for-byte identical every time — never hand-drawn
by the model. Column widths are derived from the data, so any stack renders in
the same shape.

Usage:
    python3 render_stack.py spec.json      # render a spec file
    python3 render_stack.py -              # render a spec from stdin
    python3 render_stack.py --selfcheck    # verify the canonical sample

Spec shape (layers ordered tip -> root, i.e. newest PR first):
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

`pr` may be empty for a layer whose PR hasn't been opened yet (lazy growth).
"""

import json
import sys

# State glyph legend (matches the locked canonical style A):
#   ✓ merged   ◉ open / draft (has a live PR)   ✕ closed   ○ no PR yet
GLYPH = {
    "merged": "✓",
    "open": "◉",
    "draft": "◉",
    "closed": "✕",
    "none": "○",
    "": "○",
}


def render(spec):
    layers = spec.get("layers", [])
    base = str(spec.get("base", "main"))
    name = str(spec.get("name", "stack"))
    repo = str(spec.get("repo", ""))
    n = len(layers)

    def pr_str(layer):
        pr = str(layer.get("pr") or "")
        return ("#" + pr) if pr else "—"

    prw = max((len(pr_str(l)) for l in layers), default=2)
    titlew = max((len(str(l.get("title", ""))) for l in layers), default=0) + 4
    wsw = max((len(str(l.get("ws", ""))) for l in layers), default=0) + 2

    lines = []
    header = f"stack: {name}"
    meta = " · ".join(
        part for part in (repo, f"{n} PR" + ("s" if n != 1 else "")) if part
    )
    if meta:
        header += " · " + meta
    lines.append(header)
    lines.append("")

    for i, layer in enumerate(layers):
        glyph = GLYPH.get(str(layer.get("state", "none")), "○")
        title = str(layer.get("title", ""))
        state = str(layer.get("state", ""))
        main = f"{glyph} {pr_str(layer):<{prw}}  {title:<{titlew}}{state}"
        if i == 0:
            main += "    ← HEAD"
        lines.append(main)

        ws = str(layer.get("ws", ""))
        if i + 1 < n:
            lower = layers[i + 1]
            lower_pr = str(lower.get("pr") or "")
            base_ref = ("#" + lower_pr) if lower_pr else str(lower.get("ws") or "—")
        else:
            base_ref = base
        lines.append(f"│  └ ws: {ws:<{wsw}}base ◂ {base_ref}")
        if i < n - 1:
            lines.append("│")

    lines.append(f"┴ {base}")
    return "\n".join(lines)


SELF_CHECK_SPEC = {
    "name": "dark-mode",
    "repo": "helmor/uranus",
    "base": "main",
    "layers": [
        {"pr": "483", "title": "feat: dark mode toggle", "state": "draft", "ws": "dark-mode-ui"},
        {"pr": "482", "title": "feat: persist theme pref", "state": "open", "ws": "dark-mode-api"},
        {"pr": "481", "title": "feat: add theme column", "state": "merged", "ws": "dark-mode-schema"},
    ],
}

SELF_CHECK_EXPECTED = "\n".join(
    [
        "stack: dark-mode · helmor/uranus · 3 PRs",
        "",
        "◉ #483  feat: dark mode toggle      draft    ← HEAD",
        "│  └ ws: dark-mode-ui      base ◂ #482",
        "│",
        "◉ #482  feat: persist theme pref    open",
        "│  └ ws: dark-mode-api     base ◂ #481",
        "│",
        "✓ #481  feat: add theme column      merged",
        "│  └ ws: dark-mode-schema  base ◂ main",
        "┴ main",
    ]
)


def selfcheck():
    got = render(SELF_CHECK_SPEC)
    if got == SELF_CHECK_EXPECTED:
        print("render_stack selfcheck OK")
        return 0
    print("render_stack selfcheck FAILED\n", file=sys.stderr)
    print("--- expected ---", file=sys.stderr)
    print(SELF_CHECK_EXPECTED, file=sys.stderr)
    print("--- got ---", file=sys.stderr)
    print(got, file=sys.stderr)
    return 1


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    arg = argv[1]
    if arg == "--selfcheck":
        return selfcheck()
    raw = sys.stdin.read() if arg == "-" else open(arg, encoding="utf-8").read()
    print(render(json.loads(raw)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
