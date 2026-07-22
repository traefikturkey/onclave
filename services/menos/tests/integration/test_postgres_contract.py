"""PostgreSQL and pgvector contract tests."""

import os
from pathlib import Path

import pytest
from psycopg.errors import ForeignKeyViolation, UniqueViolation

from menos.models import ChunkModel, ContentMetadata
from menos.services.database import PostgresDatabase
from menos.services.migrator import MigrationService
from menos.services.storage import PostgresRepository

pytestmark = pytest.mark.skipif(
    os.environ.get("MENOS_POSTGRES_TEST") != "1",
    reason="set MENOS_POSTGRES_TEST=1 for disposable PostgreSQL tests",
)


@pytest.fixture(scope="module")
def database():
    database = PostgresDatabase(
        host="127.0.0.1",
        port=int(os.environ["POSTGRES_TEST_PORT"]),
        database="menos_test",
        user="menos_test",
        password="menos_test_password",
        min_size=1,
        max_size=2,
    )
    database.open()
    migrations = Path(__file__).parents[2] / "migrations"
    migrator = MigrationService(database, migrations)
    assert migrator.migrate() in (["20260721-000000_initial_schema"], [])
    assert migrator.migrate() == []
    yield database
    database.close()


@pytest.fixture
def repository(database):
    for table in (
        "content_entity",
        "pipeline_job",
        "link",
        "chunk",
        "entity",
        "llm_usage",
        "tag_alias",
        "content",
    ):
        database.execute(f"DELETE FROM {table}")
    return PostgresRepository(database)


@pytest.mark.asyncio
async def test_exact_cosine_lexical_filters_and_ordering(repository):
    for content_id, title, tags, tier in (
        ("c1", "PostgreSQL vectors", ["database"], "S"),
        ("c2", "Other content", ["other"], "C"),
    ):
        await repository.create_content(
            ContentMetadata(
                id=content_id,
                content_type="document",
                title=title,
                description="PostgreSQL full text retrieval",
                mime_type="text/plain",
                file_size=1,
                file_path=f"{content_id}.txt",
                tags=tags,
                tier=tier,
            )
        )
    await repository.create_chunk(
        ChunkModel(
            id="ch1",
            content_id="c1",
            text="PostgreSQL pgvector exact cosine search",
            chunk_index=0,
            embedding=[1.0] + [0.0] * 1023,
        )
    )
    await repository.create_chunk(
        ChunkModel(
            id="ch2",
            content_id="c2",
            text="unrelated text",
            chunk_index=0,
            embedding=[0.0, 1.0] + [0.0] * 1022,
        )
    )

    rows = await repository.vector_search(
        [1.0] + [0.0] * 1023,
        limit=10,
        tags=["database"],
        valid_tiers=["S", "A"],
    )
    assert [row["content_id"] for row in rows] == ["c1"]
    lexical = await repository.lexical_search("exact cosine", limit=10)
    assert lexical[0]["content_id"] == "c1"


def test_foreign_keys_and_uniqueness(database):
    with pytest.raises(ForeignKeyViolation):
        database.execute(
            "INSERT INTO chunk(id,content_id,text,chunk_index) VALUES(%s,%s,%s,%s)",
            ("orphan", "missing", "text", 0),
        )
    database.execute(
        "INSERT INTO content(id,content_type,mime_type,file_size,file_path) VALUES(%s,%s,%s,%s,%s)",
        ("unique-content", "document", "text/plain", 1, "x"),
    )
    database.execute(
        "INSERT INTO chunk(id,content_id,text,chunk_index) VALUES(%s,%s,%s,%s)",
        ("unique-1", "unique-content", "text", 0),
    )
    with pytest.raises(UniqueViolation):
        database.execute(
            "INSERT INTO chunk(id,content_id,text,chunk_index) VALUES(%s,%s,%s,%s)",
            ("unique-2", "unique-content", "text", 0),
        )
