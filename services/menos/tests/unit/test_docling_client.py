"""Unit tests for Docling client."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from fastapi import HTTPException

from menos.services.docling import DoclingClient


def _mock_async_client(mock_post: AsyncMock) -> MagicMock:
    client = MagicMock()
    client.post = mock_post

    context_manager = MagicMock()
    context_manager.__aenter__ = AsyncMock(return_value=client)
    context_manager.__aexit__ = AsyncMock(return_value=None)
    return context_manager


@pytest.mark.asyncio
async def test_extract_markdown_posts_expected_payload():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"result": {"markdown": "# Title\nBody", "title": "Page Title"}}

    mock_post = AsyncMock(return_value=response)
    with patch(
        "menos.services.docling.httpx.AsyncClient",
        return_value=_mock_async_client(mock_post),
    ):
        client = DoclingClient("http://docling-serve:5001")
        result = await client.extract_markdown("https://example.com/article")

    assert result.markdown == "# Title\nBody"
    assert result.title == "Page Title"
    mock_post.assert_awaited_once_with(
        "http://docling-serve:5001/v1/convert/source",
        json={
            "sources": [{"kind": "http", "url": "https://example.com/article"}],
            "options": {"to_formats": ["md"], "image_export_mode": "placeholder"},
        },
    )


@pytest.mark.asyncio
async def test_extract_markdown_falls_back_to_markdown_heading_for_title():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"result": {"md": "# Heading Title\nBody text"}}

    with patch(
        "menos.services.docling.httpx.AsyncClient",
        return_value=_mock_async_client(AsyncMock(return_value=response)),
    ):
        client = DoclingClient("http://docling-serve:5001")
        result = await client.extract_markdown("https://example.com/article")

    assert result.title == "Heading Title"


@pytest.mark.asyncio
async def test_extract_markdown_supports_docling_md_content_shape():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "document": {"md_content": "# Example Domain\n\nBody text"},
        "status": "success",
    }

    with patch(
        "menos.services.docling.httpx.AsyncClient",
        return_value=_mock_async_client(AsyncMock(return_value=response)),
    ):
        client = DoclingClient("http://docling-serve:5001")
        result = await client.extract_markdown("https://example.com/article")

    assert result.markdown.startswith("# Example Domain")
    assert result.title == "Example Domain"


@pytest.mark.asyncio
async def test_extract_markdown_raises_503_on_docling_unavailable():
    request = httpx.Request("POST", "http://docling-serve:5001/v1/convert/source")
    mock_post = AsyncMock(side_effect=httpx.ConnectError("failed", request=request))

    with patch(
        "menos.services.docling.httpx.AsyncClient",
        return_value=_mock_async_client(mock_post),
    ):
        client = DoclingClient("http://docling-serve:5001")
        with pytest.raises(HTTPException) as exc_info:
            await client.extract_markdown("https://example.com/article")

    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_extract_markdown_raises_503_on_missing_markdown():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"result": {"title": "No markdown"}}

    with patch(
        "menos.services.docling.httpx.AsyncClient",
        return_value=_mock_async_client(AsyncMock(return_value=response)),
    ):
        client = DoclingClient("http://docling-serve:5001")
        with pytest.raises(HTTPException) as exc_info:
            await client.extract_markdown("https://example.com/article")

    assert exc_info.value.status_code == 503
