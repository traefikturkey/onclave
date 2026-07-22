"""Unit tests for PostgreSQL repository helpers and S3 storage."""

import io
from unittest.mock import MagicMock

import pytest

from menos.models import ContentMetadata
from menos.services.storage import (
    PostgresRepository,
    S3Storage,
    _compute_valid_tiers,
    _vector_literal,
)


def test_compute_valid_tiers():
    assert _compute_valid_tiers("S") == ["S"]
    assert _compute_valid_tiers(" b ") == ["S", "A", "B"]
    assert _compute_valid_tiers(None) == []
    assert _compute_valid_tiers("invalid") == []


def test_vector_literal_requires_exact_dimension():
    vector = _vector_literal([0.25] * 1024)
    assert vector.startswith("[") and vector.endswith("]")
    with pytest.raises(ValueError, match="exactly 1024"):
        _vector_literal([0.25] * 1023)


@pytest.mark.asyncio
async def test_s3_storage_round_trip_calls_client():
    client = MagicMock()
    response = MagicMock()
    response.read.return_value = b"payload"
    client.get_object.return_value = response
    storage = S3Storage(client, "bucket")

    assert await storage.upload("object", io.BytesIO(b"payload"), "text/plain") == 7
    assert await storage.download("object") == b"payload"
    await storage.delete("object")

    client.put_object.assert_called_once()
    client.get_object.assert_called_once_with("bucket", "object")
    client.remove_object.assert_called_once_with("bucket", "object")


@pytest.mark.asyncio
async def test_content_crud_uses_parameterized_postgres_queries():
    database = MagicMock()
    database.fetch_one.side_effect = [
        {
            "id": "content-1",
            "content_type": "document",
            "title": None,
            "description": None,
            "mime_type": "text/plain",
            "file_size": 7,
            "file_path": "object",
            "author": None,
            "tags": [],
            "tier": None,
            "metadata": {},
            "created_at": None,
            "updated_at": None,
        },
        {
            "id": "content-1",
            "content_type": "document",
            "title": None,
            "description": None,
            "mime_type": "text/plain",
            "file_size": 7,
            "file_path": "object",
            "author": None,
            "tags": [],
            "tier": None,
            "metadata": {},
            "created_at": None,
            "updated_at": None,
        },
    ]
    repository = PostgresRepository(database)
    created = await repository.create_content(
        ContentMetadata(
            id="content-1",
            content_type="document",
            mime_type="text/plain",
            file_size=7,
            file_path="object",
        )
    )
    fetched = await repository.get_content("content-1")
    assert created.id == fetched.id == "content-1"
    assert "%s" in database.fetch_one.call_args_list[0].args[0]


@pytest.mark.asyncio
async def test_vector_search_is_exact_cosine_and_bounded():
    database = MagicMock()
    database.fetch_all.return_value = []
    repository = PostgresRepository(database)
    await repository.vector_search([0.0] * 1024, limit=10, valid_tiers=["S", "A"])
    statement = database.fetch_all.call_args.args[0]
    assert "<=>" in statement
    assert "hnsw" not in statement.lower()
    with pytest.raises(ValueError, match="limit"):
        await repository.vector_search([0.0] * 1024, limit=1001)
