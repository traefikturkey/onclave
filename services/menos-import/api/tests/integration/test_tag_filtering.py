"""Integration tests for tag filtering functionality."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

from menos.services.storage import SurrealDBRepository


class TestSearchTagFiltering:
    """Tests for tag filtering in POST /api/v1/search endpoint."""

    def test_vector_search_with_tags(
        self, authed_client, mock_surreal_repo, mock_embedding_service
    ):
        """Should filter search results by tags."""
        # Mock embedding service
        mock_embedding_service.embed = AsyncMock(return_value=[0.1] * 1024)

        # Mock database query response
        mock_surreal_repo.db.query = MagicMock(return_value=[])

        # Make search request with tags
        response = authed_client.post(
            "/api/v1/search",
            json={"query": "test query", "tags": ["python", "testing"]},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["query"] == "test query"
        assert "results" in data

    def test_vector_search_without_tags(
        self, authed_client, mock_surreal_repo, mock_embedding_service
    ):
        """Should work without tag filtering."""
        # Mock embedding service
        mock_embedding_service.embed = AsyncMock(return_value=[0.1] * 1024)

        # Mock database query response
        mock_surreal_repo.db.query = MagicMock(return_value=[])

        # Make search request without tags
        response = authed_client.post(
            "/api/v1/search",
            json={"query": "test query"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["query"] == "test query"

    def test_vector_search_with_empty_tags(
        self, authed_client, mock_surreal_repo, mock_embedding_service
    ):
        """Should handle empty tags list."""
        # Mock embedding service
        mock_embedding_service.embed = AsyncMock(return_value=[0.1] * 1024)

        # Mock database query response
        mock_surreal_repo.db.query = MagicMock(return_value=[])

        # Make search request with empty tags list
        response = authed_client.post(
            "/api/v1/search",
            json={"query": "test query", "tags": []},
        )

        assert response.status_code == 200


class TestStorageTagFiltering:
    """Tests for tag filtering in storage layer."""

    def test_list_content_builds_correct_query_with_single_tag(self):
        """Should build correct WHERE clause for single tag."""
        # Create mock db
        mock_db = MagicMock()
        mock_db.query = MagicMock(return_value=[])
        repo = SurrealDBRepository(mock_db, "test", "test")

        # Call list_content with single tag
        asyncio.run(repo.list_content(tags=["python"]))

        # Verify query was called with correct WHERE clause
        call_args = mock_db.query.call_args
        query = call_args[0][0]
        params = call_args[0][1]
        assert "WHERE tags CONTAINSANY $tags" in query
        assert params["tags"] == ["python"]

    def test_list_content_builds_correct_query_with_multiple_tags(self):
        """Should build correct WHERE clause for multiple tags."""
        # Create mock db
        mock_db = MagicMock()
        mock_db.query = MagicMock(return_value=[])
        repo = SurrealDBRepository(mock_db, "test", "test")

        # Call list_content with multiple tags
        asyncio.run(repo.list_content(tags=["python", "testing"]))

        # Verify query was called with correct WHERE clause
        call_args = mock_db.query.call_args
        query = call_args[0][0]
        params = call_args[0][1]
        assert "WHERE tags CONTAINSANY $tags" in query
        assert params["tags"] == ["python", "testing"]

    def test_list_content_builds_correct_query_with_tags_and_content_type(self):
        """Should combine tags and content_type filters with AND."""
        # Create mock db
        mock_db = MagicMock()
        mock_db.query = MagicMock(return_value=[])
        repo = SurrealDBRepository(mock_db, "test", "test")

        # Call list_content with both filters
        asyncio.run(repo.list_content(tags=["python"], content_type="document"))

        # Verify query was called with both conditions
        call_args = mock_db.query.call_args
        query = call_args[0][0]
        params = call_args[0][1]
        assert "WHERE content_type = $content_type AND tags CONTAINSANY $tags" in query
        assert params["content_type"] == "document"
        assert params["tags"] == ["python"]

    def test_list_content_without_tags(self):
        """Should work without tag filtering."""
        # Create mock db
        mock_db = MagicMock()
        mock_db.query = MagicMock(return_value=[])
        repo = SurrealDBRepository(mock_db, "test", "test")

        # Call list_content without tags
        asyncio.run(repo.list_content())

        # Verify query doesn't include tags filter
        call_args = mock_db.query.call_args
        query = call_args[0][0]
        assert "tags CONTAINSANY" not in query
