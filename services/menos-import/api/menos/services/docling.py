"""Docling HTTP client for web content extraction."""

from dataclasses import dataclass

import httpx
from fastapi import HTTPException


@dataclass
class DoclingResult:
    """Extracted markdown content from Docling."""

    markdown: str
    title: str | None = None


class DoclingClient:
    """Client for Docling source conversion API."""

    def __init__(self, base_url: str, timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    async def extract_markdown(self, url: str) -> DoclingResult:
        """Extract markdown from a source URL via Docling."""
        payload = {
            "sources": [{"kind": "http", "url": url}],
            "options": {"to_formats": ["md"], "image_export_mode": "placeholder"},
        }

        endpoint = f"{self.base_url}/v1/convert/source"

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(endpoint, json=payload)
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=503, detail="Docling service unavailable") from exc

        markdown = _extract_markdown(data)
        if not markdown:
            raise HTTPException(status_code=503, detail="Docling returned no markdown")

        title = _extract_title(data) or _extract_title_from_markdown(markdown)
        return DoclingResult(markdown=markdown, title=title)


_MARKDOWN_KEYS = ("markdown", "md", "md_content")
_NESTED_KEYS = ("document", "documents", "output", "outputs", "data")
_TITLE_NESTED_KEYS = ("result",) + _NESTED_KEYS


def _extract_markdown_from_dict(data: dict) -> str | None:
    for key in _MARKDOWN_KEYS:
        val = data.get(key)
        if isinstance(val, str) and val.strip():
            return val
    for key in ("result",) + _NESTED_KEYS:
        if key in data:
            nested = _extract_markdown(data[key])
            if nested:
                return nested
    return None


def _extract_markdown(data: object) -> str | None:
    if isinstance(data, str):
        return data
    if isinstance(data, list):
        return next((m for item in data if (m := _extract_markdown(item))), None)
    if isinstance(data, dict):
        return _extract_markdown_from_dict(data)
    return None


def _str_if_nonempty(val: object) -> str | None:
    return val.strip() if isinstance(val, str) and val.strip() else None


def _extract_title_from_dict(data: dict) -> str | None:
    if result := _str_if_nonempty(data.get("title")):
        return result
    meta = data.get("metadata")
    if isinstance(meta, dict):
        if result := _str_if_nonempty(meta.get("title")):
            return result
    return next(
        (
            nested
            for key in _TITLE_NESTED_KEYS
            if key in data and (nested := _extract_title(data[key]))
        ),
        None,
    )


def _extract_title(data: object) -> str | None:
    if isinstance(data, list):
        return next((t for item in data if (t := _extract_title(item))), None)
    if isinstance(data, dict):
        return _extract_title_from_dict(data)
    return None


def _extract_title_from_markdown(markdown: str) -> str | None:
    for line in markdown.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            return stripped.lstrip("#").strip() or None
    return None
