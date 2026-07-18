"""Unit tests for content stats, entities, and chunks endpoints."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import (
    ChunkModel,
    ContentEntityEdge,
    ContentMetadata,
    EdgeType,
    EntityModel,
    EntitySource,
    EntityType,
)
from menos.services.storage import SurrealDBRepository


def _make_content(content_id: str = "c1") -> ContentMetadata:
    return ContentMetadata(
        id=content_id,
        content_type="document",
        title="Test Doc",
        mime_type="text/plain",
        file_size=100,
        file_path=f"document/{content_id}/test.txt",
    )


class TestContentStatsEndpoint:
    """Tests for GET /api/v1/content/stats."""

    def test_stats_returns_structure(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content_stats = AsyncMock(
            return_value={
                "total": 10,
                "by_status": {"completed": 7, "pending": 3},
                "by_content_type": {"document": 6, "youtube": 4},
            }
        )

        resp = authed_client.get("/api/v1/content/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 10
        assert data["by_status"] == {"completed": 7, "pending": 3}
        assert data["by_content_type"] == {"document": 6, "youtube": 4}

    def test_stats_empty(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content_stats = AsyncMock(
            return_value={"total": 0, "by_status": {}, "by_content_type": {}}
        )

        resp = authed_client.get("/api/v1/content/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["by_status"] == {}
        assert data["by_content_type"] == {}


class TestGetContentStatsRepository:
    """Tests for SurrealDBRepository.get_content_stats."""

    @pytest.mark.asyncio
    async def test_get_content_stats_aggregates(self):
        mock_db = MagicMock()
        mock_db.query.side_effect = [
            [
                {
                    "result": [
                        {"count": 5, "status": "completed"},
                        {"count": 3, "status": "pending"},
                    ]
                }
            ],
            [
                {
                    "result": [
                        {"count": 4, "content_type": "document"},
                        {"count": 4, "content_type": "youtube"},
                    ]
                }
            ],
        ]

        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")
        result = await repo.get_content_stats()

        assert result["total"] == 8
        assert result["by_status"] == {"completed": 5, "pending": 3}
        assert result["by_content_type"] == {"document": 4, "youtube": 4}

    @pytest.mark.asyncio
    async def test_get_content_stats_none_status(self):
        mock_db = MagicMock()
        mock_db.query.side_effect = [
            [{"result": [{"count": 2, "status": None}]}],
            [{"result": []}],
        ]

        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")
        result = await repo.get_content_stats()

        assert result["total"] == 2
        assert result["by_status"] == {"none": 2}
        assert result["by_content_type"] == {}

    @pytest.mark.asyncio
    async def test_get_content_stats_empty(self):
        mock_db = MagicMock()
        mock_db.query.side_effect = [[], []]

        repo = SurrealDBRepository(mock_db, "test-ns", "test-db")
        result = await repo.get_content_stats()

        assert result["total"] == 0
        assert result["by_status"] == {}
        assert result["by_content_type"] == {}


class TestContentEntitiesEndpoint:
    """Tests for GET /api/v1/content/{content_id}/entities."""

    def test_entities_happy_path(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content.return_value = _make_content()

        entity = EntityModel(
            id="ent1",
            entity_type=EntityType.TOOL,
            name="pytest",
            normalized_name="pytest",
            source=EntitySource.AI_EXTRACTED,
        )
        edge = ContentEntityEdge(
            id="edge1",
            content_id="c1",
            entity_id="ent1",
            edge_type=EdgeType.USES,
            confidence=0.9,
        )
        mock_surreal_repo.get_entities_for_content = AsyncMock(
            return_value=[(entity, edge)]
        )

        resp = authed_client.get("/api/v1/content/c1/entities")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        item = data["items"][0]
        assert item["id"] == "ent1"
        assert item["name"] == "pytest"
        assert item["entity_type"] == "tool"
        assert item["edge_type"] == "uses"
        assert item["confidence"] == 0.9

    def test_entities_404_missing_content(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.get("/api/v1/content/missing/entities")
        assert resp.status_code == 404

    def test_entities_empty(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content.return_value = _make_content()
        mock_surreal_repo.get_entities_for_content = AsyncMock(
            return_value=[]
        )

        resp = authed_client.get("/api/v1/content/c1/entities")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []


class TestContentChunksEndpoint:
    """Tests for GET /api/v1/content/{content_id}/chunks."""

    def test_chunks_happy_path_no_embeddings(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content.return_value = _make_content()

        chunk = ChunkModel(
            id="chunk1",
            content_id="c1",
            text="Some chunk text",
            chunk_index=0,
            embedding=[0.1] * 10,
        )
        mock_surreal_repo.get_chunks = AsyncMock(return_value=[chunk])

        resp = authed_client.get("/api/v1/content/c1/chunks")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        item = data["items"][0]
        assert item["id"] == "chunk1"
        assert item["chunk_index"] == 0
        assert item["text"] == "Some chunk text"
        assert item["embedding"] is None

    def test_chunks_with_embeddings(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content.return_value = _make_content()

        embedding = [0.1] * 10
        chunk = ChunkModel(
            id="chunk1",
            content_id="c1",
            text="Some chunk text",
            chunk_index=0,
            embedding=embedding,
        )
        mock_surreal_repo.get_chunks = AsyncMock(return_value=[chunk])

        resp = authed_client.get(
            "/api/v1/content/c1/chunks",
            params={"include_embeddings": "true"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["items"][0]["embedding"] == embedding

    def test_chunks_404_missing_content(
        self, authed_client, mock_surreal_repo
    ):
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.get("/api/v1/content/missing/chunks")
        assert resp.status_code == 404

    def test_chunks_empty(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content.return_value = _make_content()
        mock_surreal_repo.get_chunks = AsyncMock(return_value=[])

        resp = authed_client.get("/api/v1/content/c1/chunks")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["items"] == []
