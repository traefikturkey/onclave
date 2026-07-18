#!/usr/bin/env python
"""Script to ingest YouTube videos from a list file."""

import json
import os
import re
from pathlib import Path
from urllib.parse import urlparse

import httpx

from menos.client.signer import RequestSigner
from menos.config import settings


def extract_url(line: str) -> str | None:
    """Extract YouTube URL from a line."""
    match = re.search(r"(https?://[^\s]+youtube[^\s]+)", line)
    if match:
        return match.group(1)
    return None


def main():
    # Load private key for signing
    key_path = os.path.expanduser("~/.ssh/id_ed25519")
    signer = RequestSigner.from_file(key_path)

    # API endpoint
    base_url = settings.api_base_url

    # Read videos file (relative to repo root)
    videos_file = Path(__file__).parent.parent.parent / "data" / "youtube-videos.txt"
    content = videos_file.read_text()

    # Extract URLs
    urls = []
    for line in content.split("\n"):
        url = extract_url(line)
        if url:
            urls.append(url)

    print(f"Found {len(urls)} videos to ingest\n")

    # Ingest each video
    with httpx.Client(base_url=base_url, timeout=120) as client:
        for i, url in enumerate(urls, 1):
            print(f"[{i}/{len(urls)}] Ingesting: {url}")

            try:
                body = {
                    "url": url,
                }
                body_bytes = json.dumps(body).encode()

                headers = signer.sign_request(
                    "POST",
                    "/api/v1/ingest",
                    body=body_bytes,
                    host=urlparse(settings.api_base_url).netloc,
                )
                headers["content-type"] = "application/json"

                response = client.post(
                    "/api/v1/ingest",
                    content=body_bytes,
                    headers=headers,
                )

                if response.status_code == 200:
                    data = response.json()
                    print(f"    OK: {data.get('content_id')} - {data.get('content_type')}")
                else:
                    print(f"    ERROR {response.status_code}: {response.text}")
            except Exception as e:
                print(f"    EXCEPTION: {e}")

            print()


if __name__ == "__main__":
    main()
