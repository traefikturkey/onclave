"""Unit tests for content tags parameter and tags listing."""

import io
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import ContentMetadata
from menos.routers.content import create_content, list_tags
from menos.services.storage import MinIOStorage, SurrealDBRepository


@pytest.fixture
def mock_orchestrator():
    """Mock pipeline orchestrator for content creation tests."""
    orch = MagicMock()
    orch.submit = AsyncMock(return_value=None)
    return orch


class TestContentTagsParameter:
    """Tests for content tags parameter in POST /api/v1/content endpoint."""

    @pytest.mark.asyncio
    async def test_create_content_with_tags(self, mock_orchestrator):
        """Test creating content with tags stored in metadata."""
        mock_minio = MagicMock(spec=MinIOStorage)
        mock_minio.upload = AsyncMock(return_value=100)

        mock_repo = MagicMock(spec=SurrealDBRepository)
        created_metadata = ContentMetadata(
            id="test-123",
            content_type="document",
            title="test.txt",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-123/test.txt",
            author="test-key",
            tags=["important", "review", "urgent"],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.create_content = AsyncMock(return_value=created_metadata)

        # Mock the UploadFile with async read
        mock_file = MagicMock()
        mock_file.filename = "test.txt"
        mock_file.content_type = "text/plain"
        mock_file.file = io.BytesIO(b"test content")
        mock_file.read = AsyncMock(return_value=b"test content")
        mock_file.seek = AsyncMock()

        # Call the endpoint with tags
        result = await create_content(
            key_id="test-key",
            file=mock_file,
            content_type="document",
            title="test.txt",
            tags=["important", "review", "urgent"],
            minio_storage=mock_minio,
            surreal_repo=mock_repo,
            orchestrator=mock_orchestrator,
        )

        # Verify the result
        assert result.id == "test-123"
        assert result.file_size == 100
        assert result.file_path.startswith("document/")
        assert result.file_path.endswith("/test.txt")

        # Verify that create_content was called with the tags
        mock_repo.create_content.assert_called_once()
        call_args = mock_repo.create_content.call_args
        assert call_args is not None
        metadata = call_args[0][0]  # First positional argument
        assert isinstance(metadata, ContentMetadata)
        assert metadata.tags == ["important", "review", "urgent"]

    @pytest.mark.asyncio
    async def test_create_content_without_tags(self, mock_orchestrator):
        """Test creating content without tags defaults to empty list."""
        mock_minio = MagicMock(spec=MinIOStorage)
        mock_minio.upload = AsyncMock(return_value=100)

        mock_repo = MagicMock(spec=SurrealDBRepository)
        created_metadata = ContentMetadata(
            id="test-456",
            content_type="document",
            title="test.txt",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-456/test.txt",
            author="test-key",
            tags=[],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.create_content = AsyncMock(return_value=created_metadata)

        # Mock the UploadFile with async read
        mock_file = MagicMock()
        mock_file.filename = "test.txt"
        mock_file.content_type = "text/plain"
        mock_file.file = io.BytesIO(b"test content")
        mock_file.read = AsyncMock(return_value=b"test content")
        mock_file.seek = AsyncMock()

        # Call the endpoint without tags
        result = await create_content(
            key_id="test-key",
            file=mock_file,
            content_type="document",
            title="test.txt",
            tags=None,
            minio_storage=mock_minio,
            surreal_repo=mock_repo,
            orchestrator=mock_orchestrator,
        )

        # Verify the result
        assert result.id == "test-456"

        # Verify that create_content was called with empty tags list
        mock_repo.create_content.assert_called_once()
        call_args = mock_repo.create_content.call_args
        assert call_args is not None
        metadata = call_args[0][0]
        assert metadata.tags == []

    @pytest.mark.asyncio
    async def test_create_content_with_empty_tags_list(self, mock_orchestrator):
        """Test creating content with empty tags list."""
        mock_minio = MagicMock(spec=MinIOStorage)
        mock_minio.upload = AsyncMock(return_value=100)

        mock_repo = MagicMock(spec=SurrealDBRepository)
        created_metadata = ContentMetadata(
            id="test-789",
            content_type="document",
            title="test.txt",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-789/test.txt",
            author="test-key",
            tags=[],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.create_content = AsyncMock(return_value=created_metadata)

        # Mock the UploadFile with async read
        mock_file = MagicMock()
        mock_file.filename = "test.txt"
        mock_file.content_type = "text/plain"
        mock_file.file = io.BytesIO(b"test content")
        mock_file.read = AsyncMock(return_value=b"test content")
        mock_file.seek = AsyncMock()

        # Call the endpoint with empty tags list
        result = await create_content(
            key_id="test-key",
            file=mock_file,
            content_type="document",
            title="test.txt",
            tags=[],
            minio_storage=mock_minio,
            surreal_repo=mock_repo,
            orchestrator=mock_orchestrator,
        )

        # Verify the result
        assert result.id == "test-789"

        # Verify that create_content was called with empty tags list
        mock_repo.create_content.assert_called_once()
        call_args = mock_repo.create_content.call_args
        assert call_args is not None
        metadata = call_args[0][0]
        assert metadata.tags == []


class TestContentUpdateEndpoint:
    """Tests for PATCH /api/v1/content/{id} endpoint."""

    @pytest.mark.asyncio
    async def test_update_content_tags(self):
        """Test updating content tags."""
        from menos.routers.content import update_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        original_metadata = ContentMetadata(
            id="test-123",
            content_type="document",
            title="test.txt",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-123/test.txt",
            author="test-key",
            tags=["old-tag"],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        updated_metadata = ContentMetadata(
            id="test-123",
            content_type="document",
            title="test.txt",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-123/test.txt",
            author="test-key",
            tags=["new-tag1", "new-tag2"],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.get_content = AsyncMock(return_value=original_metadata)
        mock_repo.update_content = AsyncMock(return_value=updated_metadata)

        from menos.routers.content import ContentUpdateRequest

        update_request = ContentUpdateRequest(tags=["new-tag1", "new-tag2"])

        result = await update_content(
            content_id="test-123",
            update_request=update_request,
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert result["id"] == "test-123"
        assert result["tags"] == ["new-tag1", "new-tag2"]
        mock_repo.get_content.assert_called_once_with("test-123")
        mock_repo.update_content.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_content_not_found(self):
        """Test updating non-existent content returns 404."""
        from fastapi import HTTPException

        from menos.routers.content import update_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.get_content = AsyncMock(return_value=None)

        from menos.routers.content import ContentUpdateRequest

        update_request = ContentUpdateRequest(tags=["new-tag"])

        with pytest.raises(HTTPException) as exc_info:
            await update_content(
                content_id="nonexistent",
                update_request=update_request,
                key_id="test-key",
                surreal_repo=mock_repo,
            )

        assert exc_info.value.status_code == 404
        assert exc_info.value.detail == "Content not found"

    @pytest.mark.asyncio
    async def test_update_content_title_and_description(self):
        """Test updating content title and description."""
        from menos.routers.content import update_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        original_metadata = ContentMetadata(
            id="test-456",
            content_type="document",
            title="old-title",
            description="old description",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-456/test.txt",
            author="test-key",
            tags=[],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        updated_metadata = ContentMetadata(
            id="test-456",
            content_type="document",
            title="new-title",
            description="new description",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-456/test.txt",
            author="test-key",
            tags=[],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.get_content = AsyncMock(return_value=original_metadata)
        mock_repo.update_content = AsyncMock(return_value=updated_metadata)

        from menos.routers.content import ContentUpdateRequest

        update_request = ContentUpdateRequest(
            title="new-title",
            description="new description",
        )

        result = await update_content(
            content_id="test-456",
            update_request=update_request,
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert result["id"] == "test-456"
        assert result["title"] == "new-title"
        assert result["description"] == "new description"
        mock_repo.update_content.assert_called_once()

    @pytest.mark.asyncio
    async def test_update_content_partial_update(self):
        """Test partial update only changes specified fields."""
        from menos.routers.content import update_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        original_metadata = ContentMetadata(
            id="test-789",
            content_type="document",
            title="original-title",
            description="original description",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-789/test.txt",
            author="test-key",
            tags=["original-tag"],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        updated_metadata = ContentMetadata(
            id="test-789",
            content_type="document",
            title="original-title",
            description="original description",
            mime_type="text/plain",
            file_size=100,
            file_path="document/test-789/test.txt",
            author="test-key",
            tags=["new-tag"],
            created_at=datetime.now(),
            updated_at=datetime.now(),
        )
        mock_repo.get_content = AsyncMock(return_value=original_metadata)
        mock_repo.update_content = AsyncMock(return_value=updated_metadata)

        from menos.routers.content import ContentUpdateRequest

        update_request = ContentUpdateRequest(tags=["new-tag"])

        result = await update_content(
            content_id="test-789",
            update_request=update_request,
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert result["id"] == "test-789"
        assert result["tags"] == ["new-tag"]
        assert result["title"] == "original-title"
        assert result["description"] == "original description"


class TestListTagsEndpoint:
    """Tests for GET /api/v1/tags endpoint."""

    @pytest.mark.asyncio
    async def test_list_tags_with_counts(self):
        """Test listing all tags with their counts."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_tags_with_counts = AsyncMock(
            return_value=[
                {"name": "python", "count": 15},
                {"name": "api", "count": 8},
                {"name": "database", "count": 5},
            ]
        )

        result = await list_tags(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert len(result.tags) == 3
        assert result.tags[0].name == "python"
        assert result.tags[0].count == 15
        assert result.tags[1].name == "api"
        assert result.tags[1].count == 8
        assert result.tags[2].name == "database"
        assert result.tags[2].count == 5
        mock_repo.list_tags_with_counts.assert_called_once()

    @pytest.mark.asyncio
    async def test_list_tags_empty(self):
        """Test listing tags when no content has tags."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_tags_with_counts = AsyncMock(return_value=[])

        result = await list_tags(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert len(result.tags) == 0
        mock_repo.list_tags_with_counts.assert_called_once()

    @pytest.mark.asyncio
    async def test_list_tags_preserves_order_from_service(self):
        """Test that endpoint preserves the order from list_tags_with_counts."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_tags_with_counts = AsyncMock(
            return_value=[
                {"name": "python", "count": 15},
                {"name": "zebra", "count": 10},
                {"name": "apple", "count": 10},
                {"name": "database", "count": 5},
            ]
        )

        result = await list_tags(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert len(result.tags) == 4
        assert result.tags[0].name == "python"
        assert result.tags[0].count == 15
        assert result.tags[1].name == "zebra"
        assert result.tags[1].count == 10
        assert result.tags[2].name == "apple"
        assert result.tags[2].count == 10
        assert result.tags[3].name == "database"
        assert result.tags[3].count == 5


class TestPostgresRepositoryListTagsWithCounts:
    """Tests for PostgreSQL tag aggregation."""

    @pytest.mark.asyncio
    async def test_list_tags_preserves_database_order_and_counts(self):
        mock_db = MagicMock()
        mock_db.fetch_all.return_value = [
            {"name": "api", "count": 3},
            {"name": "database", "count": 1},
            {"name": "python", "count": 1},
        ]
        repo = SurrealDBRepository(mock_db)

        result = await repo.list_tags_with_counts()

        assert result == mock_db.fetch_all.return_value
        query = mock_db.fetch_all.call_args.args[0]
        assert "unnest(tags)" in query
        assert "ORDER BY count DESC,tag ASC" in query

    @pytest.mark.asyncio
    async def test_list_tags_empty(self):
        mock_db = MagicMock()
        mock_db.fetch_all.return_value = []
        assert await SurrealDBRepository(mock_db).list_tags_with_counts() == []


class TestContentRouterExcludeTagsLogic:
    """Tests for exclude_tags override logic in content router."""

    @pytest.mark.asyncio
    async def test_tags_filter_removes_test_from_exclude_tags(self):
        """Test that when tags=test is passed, 'test' is removed from exclude_tags."""
        from menos.routers.content import list_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 0))

        # Call with tags=test (should remove "test" from default exclude_tags)
        await list_content(
            key_id="test-key",
            tags="test",
            exclude_tags=None,  # Should default to ["test"], then be overridden
            surreal_repo=mock_repo,
        )

        # Verify list_content was called with effective_exclude_tags=[]
        call_args = mock_repo.list_content.call_args
        assert call_args.kwargs["exclude_tags"] == []

    @pytest.mark.asyncio
    async def test_tags_filter_keeps_other_exclusions(self):
        """Test that tags=test only removes 'test', not other exclude_tags."""
        from menos.routers.content import list_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 0))

        # Call with tags=test and exclude_tags=test,draft
        await list_content(
            key_id="test-key",
            tags="test",
            exclude_tags="test,draft",
            surreal_repo=mock_repo,
        )

        # Verify 'test' was removed but 'draft' remains
        call_args = mock_repo.list_content.call_args
        assert call_args.kwargs["exclude_tags"] == ["draft"]

    @pytest.mark.asyncio
    async def test_exclude_tags_empty_string_disables_exclusion(self):
        """Test that exclude_tags='' (empty string) results in empty list."""
        from menos.routers.content import list_content

        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 0))

        await list_content(
            key_id="test-key",
            exclude_tags="",
            surreal_repo=mock_repo,
        )

        # Verify exclude_tags=[] was passed
        call_args = mock_repo.list_content.call_args
        assert call_args.kwargs["exclude_tags"] == []


class TestExcludeTagsParameter:
    """Tests for PostgreSQL list-content tag filtering."""

    @staticmethod
    def _repo():
        database = MagicMock()
        database.fetch_one.return_value = {"count": 0}
        database.fetch_all.return_value = []
        return SurrealDBRepository(database), database

    @pytest.mark.asyncio
    async def test_default_excludes_test_tag(self):
        repo, database = self._repo()
        await repo.list_content()

        count_sql, count_params = database.fetch_one.call_args.args
        list_sql, list_params = database.fetch_all.call_args.args
        assert "NOT tags && %s" in count_sql
        assert "NOT tags && %s" in list_sql
        assert count_params == [["test"]]
        assert list_params[:1] == (["test"],)

    @pytest.mark.asyncio
    async def test_empty_exclude_tags_disables_exclusion(self):
        repo, database = self._repo()
        await repo.list_content(exclude_tags=[])

        assert "NOT tags &&" not in database.fetch_one.call_args.args[0]
        assert "NOT tags &&" not in database.fetch_all.call_args.args[0]

    @pytest.mark.asyncio
    async def test_included_tag_is_not_excluded(self):
        repo, database = self._repo()
        await repo.list_content(tags=["test"])

        sql, params = database.fetch_one.call_args.args
        assert "tags && %s" in sql
        assert "NOT tags &&" not in sql
        assert params == [["test"]]
