#!/usr/bin/env python3
"""Reject site-specific addresses, domains, users, and deploy paths."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SELF = Path(__file__).resolve().relative_to(REPO_ROOT).as_posix()
PATTERNS = {
    "RFC1918 address": re.compile(
        r"(?<![0-9])(?:10(?:\.[0-9]{1,3}){3}|172\.(?:1[6-9]|2[0-9]|3[01])"
        r"(?:\.[0-9]{1,3}){2}|192\.168(?:\.[0-9]{1,3}){2})(?![0-9])"
    ),
    "private domain": re.compile(r"(?:ilude\.com|traefikturkey\.icu)", re.IGNORECASE),
    "site SSH user": re.compile(r"\banvil\b"),
    "site deploy path": re.compile(r"/apps/(?:onclave|menos)\b"),
}


def tracked_paths() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
    )
    return [path.decode() for path in result.stdout.split(b"\0") if path]


def main() -> int:
    findings: list[str] = []
    for relative_path in tracked_paths():
        if relative_path == SELF:
            continue
        path = REPO_ROOT / relative_path
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_number, line in enumerate(text.splitlines(), 1):
            for label, pattern in PATTERNS.items():
                if pattern.search(line):
                    findings.append(f"{relative_path}:{line_number}: {label}")

    if findings:
        print("public-safety check failed:")
        for finding in findings:
            print(f"- {finding}")
        return 1

    print("public-safety check passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
