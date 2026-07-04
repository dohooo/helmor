#!/usr/bin/env python3
"""Build a compact markdown evidence pack from local debugging artifacts."""

from __future__ import annotations

import argparse
from pathlib import Path


TEXT_EXTENSIONS = {
    ".txt",
    ".log",
    ".json",
    ".jsonl",
    ".md",
    ".html",
    ".xml",
    ".yaml",
    ".yml",
}


def tail_text(path: Path, max_lines: int) -> str:
    text = path.read_text(errors="replace")
    lines = text.splitlines()
    return "\n".join(lines[-max_lines:])


def parse_artifact(value: str) -> tuple[str, Path]:
    if "=" not in value:
        path = Path(value)
        return (path.stem or "artifact", path)
    label, raw_path = value.split("=", 1)
    return (label.strip() or "artifact", Path(raw_path))


def render_artifact(label: str, path: Path, max_lines: int) -> str:
    exists = path.exists()
    out = [f"## {label}", "", f"- Path: `{path}`", f"- Exists: `{str(exists).lower()}`"]
    if not exists:
        return "\n".join(out) + "\n"

    if path.suffix.lower() in TEXT_EXTENSIONS:
        out.extend(["", "```text", tail_text(path, max_lines), "```"])
    else:
        out.extend(["", f"![{label}]({path})"])
    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, help="Markdown output path.")
    parser.add_argument("--title", default="Helmor Debug Evidence")
    parser.add_argument("--status", default="inconclusive")
    parser.add_argument("--summary", default="")
    parser.add_argument(
        "--artifact",
        action="append",
        default=[],
        help="Artifact as label=path, repeatable. Text files are tailed; images are linked.",
    )
    parser.add_argument("--max-lines", type=int, default=200)
    args = parser.parse_args()

    parts = [
        f"# {args.title}",
        "",
        f"- Status: `{args.status}`",
    ]
    if args.summary:
        parts.extend(["", args.summary])

    for value in args.artifact:
        label, path = parse_artifact(value)
        parts.extend(["", render_artifact(label, path, max(0, args.max_lines)).rstrip()])

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(parts).rstrip() + "\n")
    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
