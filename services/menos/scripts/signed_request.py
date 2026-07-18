#!/usr/bin/env python
"""Make RFC 9421-signed HTTP requests to the menos API."""

import argparse
import json
import os
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

import httpx

from menos.client.signer import RequestSigner
from menos.config import settings


def _fix_msys_path(path: str) -> str:
    """Fix MSYS/Git Bash path mangling (e.g. C:/api/v1/content -> /api/v1/content)."""
    mangled = re.match(r"^[A-Za-z]:(/.+)$", path)
    if mangled:
        return mangled.group(1)
    return path


def _parse_host(base_url: str) -> str:
    """Extract host[:port] from a base URL."""
    parsed = urlparse(base_url)
    host = parsed.hostname
    if parsed.port and parsed.port not in (80, 443):
        host = f"{host}:{parsed.port}"
    return host


def _parse_body(raw: str) -> bytes:
    """Validate and encode a JSON body string. Exits on invalid JSON."""
    try:
        json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"Invalid JSON body: {e}", file=sys.stderr)
        sys.exit(1)
    return raw.encode()


def _print_response(response: httpx.Response, verbose: bool) -> None:
    """Print the response body and optional status line."""
    content_type = response.headers.get("content-type", "")
    if "application/json" in content_type:
        try:
            print(json.dumps(response.json(), indent=2))
        except (json.JSONDecodeError, ValueError):
            print(response.text)
    else:
        print(response.text)

    if verbose:
        print(f"\n--- {response.status_code} {response.reason_phrase} ---", file=sys.stderr)


def main():
    os.environ.setdefault("MSYS_NO_PATHCONV", "1")

    parser = argparse.ArgumentParser(description="Make signed HTTP requests to the menos API")
    parser.add_argument("method", help="HTTP method (GET, POST, DELETE, PATCH, PUT)")
    parser.add_argument("path", help="Request path (e.g. /api/v1/content)")
    parser.add_argument("body", nargs="?", default=None, help="JSON request body")
    parser.add_argument(
        "--key",
        default=str(Path.home() / ".ssh" / "id_ed25519"),
        help="Path to ed25519 private key (default: ~/.ssh/id_ed25519)",
    )
    parser.add_argument("--verbose", "-v", action="store_true", help="Show request details")
    parser.add_argument(
        "--timeout", type=float, default=30, help="Request timeout in seconds (default: 30)"
    )
    args = parser.parse_args()

    request_path = _fix_msys_path(args.path)
    base_url = settings.api_base_url
    method = args.method.upper()
    url = f"{base_url}{request_path}"
    host = _parse_host(base_url)

    body_bytes = _parse_body(args.body) if args.body else None

    signer = RequestSigner.from_file(args.key)
    sig_headers = signer.sign_request(method, request_path, body=body_bytes, host=host)
    headers = {**sig_headers}
    if body_bytes:
        headers["content-type"] = "application/json"

    if args.verbose:
        print(f"{method} {url}", file=sys.stderr)
        for k, v in headers.items():
            print(f"  {k}: {v}", file=sys.stderr)
        print(file=sys.stderr)

    response = httpx.request(method, url, headers=headers, content=body_bytes, timeout=args.timeout)
    _print_response(response, args.verbose)
    sys.exit(0 if response.is_success else 1)


if __name__ == "__main__":
    main()
