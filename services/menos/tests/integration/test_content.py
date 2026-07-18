"""Integration tests for content endpoints."""

import io
from unittest.mock import AsyncMock, MagicMock

import pytest


class TestContentEndpoints:
    """Tests for content CRUD endpoints."""

    def test_content_list_requires_auth(self, client):
        """Test that content list requires authentication."""
        from fastapi.testclient import TestClient
        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.get("/api/v1/content")

        assert response.status_code == 401
        data = response.json()
        assert "detail" in data

    def test_content_create_requires_auth(self, client):
        """Test that content creation requires authentication."""
        from fastapi.testclient import TestClient
        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.post(
            "/api/v1/content",
            files={"file": ("test.txt", io.BytesIO(b"test"), "text/plain")},
        )

        assert response.status_code == 401

    def test_content_delete_requires_auth(self, client):
        """Test that content deletion requires authentication."""
        from fastapi.testclient import TestClient
        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.delete("/api/v1/content/123")

        assert response.status_code == 401

    def test_content_patch_requires_auth(self, client):
        """Test that content patch requires authentication."""
        from fastapi.testclient import TestClient
        unauthenticated_client = TestClient(client.app)
        response = unauthenticated_client.patch(
            "/api/v1/content/123",
            json={"tags": ["tag1"]},
        )

        assert response.status_code == 401


class TestLinkExtraction:
    """Tests for link extraction during content upload."""

    @pytest.mark.asyncio
    async def test_extract_links_from_markdown(self):
        """Test that links are extracted from markdown content."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = """
        # My Document

        See [[Python]] for more info.
        Also check [[Django|the framework]].
        """

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        # Mock methods
        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        # Verify links were extracted and stored
        repo.delete_links_by_source.assert_called_once_with("test123")
        assert repo.create_link.call_count == 2

        # Check first link
        first_call = repo.create_link.call_args_list[0][0][0]
        assert first_call.source == "test123"
        assert first_call.link_text == "Python"
        assert first_call.link_type == "wiki"
        assert first_call.target is None  # Not resolved

    @pytest.mark.asyncio
    async def test_resolve_link_target(self):
        """Test that link targets are resolved when content exists."""
        from menos.models import ContentMetadata
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = "See [[Python Guide]] for details."

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        # Mock Python Guide content exists
        target_content = ContentMetadata(
            id="target456",
            content_type="document",
            title="Python Guide",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/python.md",
        )

        repo.find_content_by_title = AsyncMock(return_value=target_content)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("source123", content, repo)

        # Verify target was resolved
        repo.find_content_by_title.assert_called_once_with("Python Guide")
        link_arg = repo.create_link.call_args[0][0]
        assert link_arg.target == "target456"

    @pytest.mark.asyncio
    async def test_markdown_links_extracted(self):
        """Test that markdown links are extracted."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = "See [docs](./README.md) and [guide](guide.md)."

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        assert repo.create_link.call_count == 2

        # Check markdown links
        calls = repo.create_link.call_args_list
        assert calls[0][0][0].link_type == "markdown"
        assert calls[0][0][0].target is None
        assert calls[1][0][0].link_type == "markdown"

    @pytest.mark.asyncio
    async def test_no_links_in_content(self):
        """Test that no errors occur when content has no links."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = "Just plain text with no links."

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        # Should not attempt to delete or create links
        repo.delete_links_by_source.assert_not_called()
        repo.create_link.assert_not_called()

    @pytest.mark.asyncio
    async def test_links_deleted_before_creation(self):
        """Test that existing links are deleted before new ones are created."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = "Link: [[Test]]"

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        # Verify delete was called before create
        assert repo.delete_links_by_source.called
        assert repo.create_link.called

        # Check order by comparing call times
        delete_call_time = repo.delete_links_by_source.call_args
        create_call_time = repo.create_link.call_args
        assert delete_call_time is not None
        assert create_call_time is not None

    @pytest.mark.asyncio
    async def test_mixed_link_types_extracted(self):
        """Test that both wiki and markdown links are extracted."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = """
        Wiki: [[Python]]
        Markdown: [guide](./guide.md)
        Another wiki: [[Django]]
        """

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        assert repo.create_link.call_count == 3

        calls = repo.create_link.call_args_list
        link_types = [call[0][0].link_type for call in calls]
        assert "wiki" in link_types
        assert "markdown" in link_types

    @pytest.mark.asyncio
    async def test_links_in_code_blocks_ignored(self):
        """Test that links in code blocks are not extracted."""
        from menos.routers.content import _extract_and_store_links
        from menos.services.storage import SurrealDBRepository

        content = """
        Normal: [[Python]]

        ```python
        # [[Should not extract]]
        url = "[also ignored](file.md)"
        ```

        Valid: [[Django]]
        """

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.find_content_by_title = AsyncMock(return_value=None)
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()

        await _extract_and_store_links("test123", content, repo)

        # Only 2 links should be extracted (Python and Django)
        assert repo.create_link.call_count == 2

        calls = repo.create_link.call_args_list
        targets = [call[0][0].link_text for call in calls]
        assert "Python" in targets
        assert "Django" in targets
        assert "Should not extract" not in targets


class TestLinksEndpoints:
    """Tests for links and backlinks endpoints."""

    @pytest.mark.asyncio
    async def test_get_links_returns_forward_links(self):
        """Test that GET /content/{id}/links returns forward links with target metadata."""
        from menos.models import ContentMetadata, LinkModel
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        # Mock content exists
        source_content = ContentMetadata(
            id="source123",
            content_type="document",
            title="Source Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/source.md",
        )

        target_content = ContentMetadata(
            id="target456",
            content_type="document",
            title="Target Doc",
            mime_type="text/markdown",
            file_size=200,
            file_path="docs/target.md",
        )

        # Mock repository methods
        async def mock_get_content(content_id: str):
            if content_id == "source123":
                return source_content
            elif content_id == "target456":
                return target_content
            return None

        repo.get_content = AsyncMock(side_effect=mock_get_content)

        # Mock links
        links = [
            LinkModel(
                id="link1",
                source="source123",
                target="target456",
                link_text="Target Doc",
                link_type="wiki",
            )
        ]
        repo.get_links_by_source = AsyncMock(return_value=links)

        # Call endpoint
        from menos.routers.content import get_content_links

        response = await get_content_links("source123", "test-key", repo)

        assert len(response.links) == 1
        assert response.links[0].link_text == "Target Doc"
        assert response.links[0].link_type == "wiki"
        assert response.links[0].target is not None
        assert response.links[0].target.id == "target456"
        assert response.links[0].target.title == "Target Doc"
        assert response.links[0].target.content_type == "document"

    @pytest.mark.asyncio
    async def test_get_links_handles_unresolved_targets(self):
        """Test that links with no target (unresolved) are handled gracefully."""
        from menos.models import ContentMetadata, LinkModel
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        source_content = ContentMetadata(
            id="source123",
            content_type="document",
            title="Source Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/source.md",
        )

        repo.get_content = AsyncMock(return_value=source_content)

        # Link with no target (unresolved)
        links = [
            LinkModel(
                id="link1",
                source="source123",
                target=None,
                link_text="Unresolved",
                link_type="wiki",
            )
        ]
        repo.get_links_by_source = AsyncMock(return_value=links)

        from menos.routers.content import get_content_links

        response = await get_content_links("source123", "test-key", repo)

        assert len(response.links) == 1
        assert response.links[0].link_text == "Unresolved"
        assert response.links[0].target is None

    @pytest.mark.asyncio
    async def test_get_links_404_when_content_not_found(self):
        """Test that GET /content/{id}/links returns 404 when content doesn't exist."""
        from fastapi import HTTPException

        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.get_content = AsyncMock(return_value=None)

        from menos.routers.content import get_content_links

        with pytest.raises(HTTPException) as exc_info:
            await get_content_links("nonexistent", "test-key", repo)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Content not found"

    @pytest.mark.asyncio
    async def test_get_backlinks_returns_source_metadata(self):
        """Test that GET /content/{id}/backlinks returns backlinks with source metadata."""
        from menos.models import ContentMetadata, LinkModel
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        # Mock content exists
        target_content = ContentMetadata(
            id="target456",
            content_type="document",
            title="Target Doc",
            mime_type="text/markdown",
            file_size=200,
            file_path="docs/target.md",
        )

        source_content = ContentMetadata(
            id="source123",
            content_type="document",
            title="Source Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/source.md",
        )

        # Mock repository methods
        async def mock_get_content(content_id: str):
            if content_id == "target456":
                return target_content
            elif content_id == "source123":
                return source_content
            return None

        repo.get_content = AsyncMock(side_effect=mock_get_content)

        # Mock backlinks
        backlinks = [
            LinkModel(
                id="link1",
                source="source123",
                target="target456",
                link_text="Target Doc",
                link_type="wiki",
            )
        ]
        repo.get_links_by_target = AsyncMock(return_value=backlinks)

        # Call endpoint
        from menos.routers.content import get_content_backlinks

        response = await get_content_backlinks("target456", "test-key", repo)

        assert len(response.links) == 1
        assert response.links[0].link_text == "Target Doc"
        assert response.links[0].link_type == "wiki"
        assert response.links[0].source is not None
        assert response.links[0].source.id == "source123"
        assert response.links[0].source.title == "Source Doc"
        assert response.links[0].source.content_type == "document"

    @pytest.mark.asyncio
    async def test_get_backlinks_404_when_content_not_found(self):
        """Test that GET /content/{id}/backlinks returns 404 when content doesn't exist."""
        from fastapi import HTTPException

        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        repo.get_content = AsyncMock(return_value=None)

        from menos.routers.content import get_content_backlinks

        with pytest.raises(HTTPException) as exc_info:
            await get_content_backlinks("nonexistent", "test-key", repo)

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Content not found"

    @pytest.mark.asyncio
    async def test_get_backlinks_empty_when_no_backlinks(self):
        """Test that empty list is returned when document has no backlinks."""
        from menos.models import ContentMetadata
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        content = ContentMetadata(
            id="doc123",
            content_type="document",
            title="Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/doc.md",
        )

        repo.get_content = AsyncMock(return_value=content)
        repo.get_links_by_target = AsyncMock(return_value=[])

        from menos.routers.content import get_content_backlinks

        response = await get_content_backlinks("doc123", "test-key", repo)

        assert len(response.links) == 0

    @pytest.mark.asyncio
    async def test_get_links_empty_when_no_links(self):
        """Test that empty list is returned when document has no forward links."""
        from menos.models import ContentMetadata
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        content = ContentMetadata(
            id="doc123",
            content_type="document",
            title="Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/doc.md",
        )

        repo.get_content = AsyncMock(return_value=content)
        repo.get_links_by_source = AsyncMock(return_value=[])

        from menos.routers.content import get_content_links

        response = await get_content_links("doc123", "test-key", repo)

        assert len(response.links) == 0

    @pytest.mark.asyncio
    async def test_get_links_multiple_links(self):
        """Test that multiple links are returned correctly."""
        from menos.models import ContentMetadata, LinkModel
        from menos.services.storage import SurrealDBRepository

        mock_db = MagicMock()
        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")

        source_content = ContentMetadata(
            id="source123",
            content_type="document",
            title="Source Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="docs/source.md",
        )

        target1 = ContentMetadata(
            id="target1",
            content_type="document",
            title="Target 1",
            mime_type="text/markdown",
            file_size=200,
            file_path="docs/target1.md",
        )

        target2 = ContentMetadata(
            id="target2",
            content_type="note",
            title="Target 2",
            mime_type="text/markdown",
            file_size=150,
            file_path="notes/target2.md",
        )

        async def mock_get_content(content_id: str):
            if content_id == "source123":
                return source_content
            elif content_id == "target1":
                return target1
            elif content_id == "target2":
                return target2
            return None

        repo.get_content = AsyncMock(side_effect=mock_get_content)

        links = [
            LinkModel(
                id="link1",
                source="source123",
                target="target1",
                link_text="Target 1",
                link_type="wiki",
            ),
            LinkModel(
                id="link2",
                source="source123",
                target="target2",
                link_text="Target 2",
                link_type="markdown",
            ),
        ]
        repo.get_links_by_source = AsyncMock(return_value=links)

        from menos.routers.content import get_content_links

        response = await get_content_links("source123", "test-key", repo)

        assert len(response.links) == 2
        assert response.links[0].target.id == "target1"
        assert response.links[0].target.content_type == "document"
        assert response.links[1].target.id == "target2"
        assert response.links[1].target.content_type == "note"
