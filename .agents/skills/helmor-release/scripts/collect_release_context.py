#!/usr/bin/env python3

import subprocess
import sys
from collections import defaultdict


def run(*args: str) -> str:
    result = subprocess.run(
        args,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def try_run(*args: str) -> str:
    try:
        return run(*args)
    except subprocess.CalledProcessError:
        return ""


def detect_base() -> str:
    for candidate in ("origin/main", "main", "origin/master", "master"):
        if try_run("git", "rev-parse", "--verify", candidate):
            return candidate
    return "HEAD~1"


def group_path(path: str) -> str:
    if path.startswith("src-tauri/src/updater/") or path.endswith(
        "updater_commands.rs",
    ):
        return "App updater runtime"
    if path.startswith(".github/workflows/") or path.startswith("scripts/"):
        return "Release automation"
    if path.startswith(".changeset/") or path == "CHANGELOG.md":
        return "Release notes and versioning"
    if path.startswith("src/features/settings/") or path.startswith(
        "src/features/updater/",
    ):
        return "Settings and update UI"
    if path.startswith("src/") or path.startswith("src-tauri/"):
        return "Application code"
    if path.startswith("docs/"):
        return "Documentation"
    if path.startswith("sidecar/"):
        return "Sidecar and bundled tooling"
    return "Other"


def main() -> int:
    branch = run("git", "branch", "--show-current")
    base = detect_base()

    commits_raw = try_run("git", "log", "--oneline", f"{base}..HEAD")
    commits = [line for line in commits_raw.splitlines() if line]

    files_raw = try_run("git", "diff", "--name-only", f"{base}...HEAD")
    files = [line for line in files_raw.splitlines() if line]

    grouped: dict[str, list[str]] = defaultdict(list)
    for file_path in files:
        grouped[group_path(file_path)].append(file_path)

    print(f"Branch: {branch}")
    print(f"Base: {base}")
    print()

    print("Commits:")
    if commits:
        for commit in commits:
            print(f"- {commit}")
    else:
        print("- No commits ahead of base")
    print()

    print("Changed areas:")
    if grouped:
        for area in sorted(grouped):
            print(f"- {area}:")
            for file_path in grouped[area][:8]:
                print(f"  - {file_path}")
            remaining = len(grouped[area]) - 8
            if remaining > 0:
                print(f"  - ... and {remaining} more")
    else:
        print("- No changed files")
    print()

    suggestions = []
    if "App updater runtime" in grouped or "Settings and update UI" in grouped:
        suggestions.append(
            "Add background app-update checks and a ready-to-install prompt.",
        )
    if "Release automation" in grouped or "Release notes and versioning" in grouped:
        suggestions.append(
            "Add release automation for signed macOS builds and GitHub Releases.",
        )
    if "Sidecar and bundled tooling" in grouped:
        suggestions.append(
            "Improve bundled tooling so packaged releases can pass signing and notarization.",
        )

    print("Suggested user-facing bullets:")
    if suggestions:
        for item in suggestions:
            print(f"- {item}")
    else:
        print("- No obvious user-facing bullets detected; inspect commits manually.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
