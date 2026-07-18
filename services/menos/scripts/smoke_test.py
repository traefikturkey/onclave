#!/usr/bin/env python
"""Run smoke tests against a live Menos API deployment."""

import argparse
import os
import subprocess
import sys
from pathlib import Path

from menos.config import settings


def main() -> int:
    """Run smoke tests with environment configuration.

    Returns:
        Exit code from pytest
    """
    parser = argparse.ArgumentParser(
        description="Run smoke tests against a live Menos API deployment"
    )
    parser.add_argument(
        "--url",
        default=settings.api_base_url,
        help="API base URL (reads API_BASE_URL from .env)",
    )
    parser.add_argument(
        "--key-file",
        default=str(Path.home() / ".ssh" / "id_ed25519"),
        help="Path to SSH private key (default: ~/.ssh/id_ed25519)",
    )
    parser.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Verbose test output",
    )
    parser.add_argument(
        "-x",
        "--exitfirst",
        action="store_true",
        help="Stop on first test failure",
    )
    args = parser.parse_args()

    # Set environment variables for smoke test fixtures
    os.environ["API_BASE_URL"] = args.url
    os.environ["SMOKE_TEST_KEY_FILE"] = args.key_file

    # Build pytest command
    cmd = ["uv", "run", "pytest", "tests/smoke/", "-m", "smoke"]
    if args.verbose:
        cmd.append("-v")
    if args.exitfirst:
        cmd.append("-x")

    # Print summary of configuration
    print("=" * 60)
    print("Menos API Smoke Tests")
    print("=" * 60)
    print(f"Target URL:  {args.url}")
    print(f"SSH Key:     {args.key_file}")
    print(f"Verbose:     {args.verbose}")
    print("-" * 60)

    # Run pytest
    result = subprocess.run(
        cmd,
        cwd=Path(__file__).parent.parent,
        check=False,
    )

    # Print summary
    print("-" * 60)
    if result.returncode == 0:
        print("Smoke tests PASSED")
    else:
        print(f"Smoke tests FAILED (exit code: {result.returncode})")
    print("=" * 60)

    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
