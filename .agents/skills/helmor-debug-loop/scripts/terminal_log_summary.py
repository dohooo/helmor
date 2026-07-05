#!/usr/bin/env python3
"""Summarize Helmor terminal/run-script logs for debugging evidence."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ANSI_RE = re.compile(r"\x1b(?:\[[0-9;?=<>]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|[@-Z\\-_])")
URL_RE = re.compile(r"https?://(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1|[^\s'\"<>]+)[^\s'\"<>]*")
ERROR_RE = re.compile(
    r"\b(error|exception|panic|failed|failure|traceback|unhandled|cannot|could not|enoent|eaddrinuse)\b",
    re.IGNORECASE,
)
WARNING_RE = re.compile(r"\b(warn|warning|deprecated)\b", re.IGNORECASE)


def read_text(path: str | None) -> str:
    if path:
        return Path(path).read_text(errors="replace")
    return sys.stdin.read()


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def summarize(text: str, tail_lines: int) -> dict[str, object]:
    clean = strip_ansi(text).replace("\r\n", "\n").replace("\r", "\n")
    lines = clean.splitlines()
    error_lines = [line for line in lines if ERROR_RE.search(line)]
    warning_lines = [line for line in lines if WARNING_RE.search(line)]
    urls = unique(URL_RE.findall(clean))
    return {
        "bytes": len(text.encode()),
        "cleanBytes": len(clean.encode()),
        "lineCount": len(lines),
        "urls": urls[:20],
        "errorCount": len(error_lines),
        "warningCount": len(warning_lines),
        "errors": error_lines[-20:],
        "warnings": warning_lines[-20:],
        "tail": lines[-tail_lines:],
    }


def print_markdown(summary: dict[str, object]) -> None:
    print("# Terminal Log Summary\n")
    print(f"- Bytes: {summary['bytes']}")
    print(f"- Clean bytes: {summary['cleanBytes']}")
    print(f"- Lines: {summary['lineCount']}")
    print(f"- Errors: {summary['errorCount']}")
    print(f"- Warnings: {summary['warningCount']}")

    urls = summary["urls"]
    if urls:
        print("\n## URLs")
        for url in urls:
            print(f"- `{url}`")

    errors = summary["errors"]
    if errors:
        print("\n## Recent Error Lines")
        for line in errors:
            print(f"- `{line[:500]}`")

    warnings = summary["warnings"]
    if warnings:
        print("\n## Recent Warning Lines")
        for line in warnings:
            print(f"- `{line[:500]}`")

    print("\n## Tail")
    print("```text")
    for line in summary["tail"]:
        print(line)
    print("```")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", help="Log file path. Reads stdin when omitted.")
    parser.add_argument("--tail-lines", type=int, default=120)
    parser.add_argument("--json", action="store_true", help="Emit JSON instead of markdown.")
    args = parser.parse_args()

    summary = summarize(read_text(args.path), max(0, args.tail_lines))
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print_markdown(summary)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
