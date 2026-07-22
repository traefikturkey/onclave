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
    """Tests for PostgreSQL tag filtering in the storage layer."""

    @staticmethod
    def _list(tags=None, content_type=None):
        database = MagicMock()
        database.fetch_one.return_value = {"count": 0}
        database.fetch_all.return_value = []
        repo = SurrealDBRepository(database)
        asyncio.run(repo.list_content(tags=tags, content_type=content_type))
        return database.fetch_all.call_args.args

    def test_list_content_builds_correct_query_with_single_tag(self):
        query, params = self._list(tags=["python"])
        assert "WHERE tags && %s" in query
        assert params[0] == ["python"]

    def test_list_content_builds_correct_query_with_multiple_tags(self):
        query, params = self._list(tags=["python", "testing"])
        assert "WHERE tags && %s" in query
        assert params[0] == ["python", "testing"]

    def test_list_content_builds_query_with_tags_and_content_type(self):
        query, params = self._list(tags=["python"], content_type="document")
        assert "WHERE content_type = %s AND tags && %s" in query
        assert params[:2] == ("document", ["python"])

    def test_list_content_without_tags_uses_default_exclusion_only(self):
        query, params = self._list()
        assert "WHERE NOT tags && %s" in query
        assert params[0] == ["test"]
