"""Unit tests for content reprocessing script logic."""

import json
import sys
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import ContentMetadata
from menos.services.storage import MinIOStorage, SurrealDBRepository

# Import the ContentReprocessor class by adding scripts to path
scripts_path = Path(__file__).parent.parent.parent / "scripts"
sys.path.insert(0, str(scripts_path))

from reprocess_content import ContentReprocessor  # noqa: E402


class TestContentReprocessor:
    """Test ContentReprocessor logic."""

    @pytest.fixture
    def mock_surreal_repo(self):
        """Create mock SurrealDB repository."""
        repo = MagicMock(spec=SurrealDBRepository)
        repo.list_content = AsyncMock()
        repo.get_content = AsyncMock()
        repo.update_content = AsyncMock()
        repo.delete_links_by_source = AsyncMock()
        repo.create_link = AsyncMock()
        repo.find_content_by_title = AsyncMock()
        return repo

    @pytest.fixture
    def mock_minio_storage(self):
        """Create mock MinIO storage."""
        storage = MagicMock(spec=MinIOStorage)
        storage.download = AsyncMock()
        return storage

    @pytest.fixture
    def reprocessor(self, mock_surreal_repo, mock_minio_storage):
        """Create ContentReprocessor instance."""
        return ContentReprocessor(mock_surreal_repo, mock_minio_storage)

    async def test_reprocess_youtube_extracts_tags_from_metadata(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test YouTube video reprocessing extracts tags from metadata.json."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="youtube",
            title="Test Video",
            mime_type="text/plain",
            file_size=1000,
            file_path="youtube/abc123/transcript.txt",
            tags=[],
            metadata={"video_id": "abc123"},
        )

        metadata_json = json.dumps({"tags": ["python", "tutorial", "coding"]})
        mock_minio_storage.download.return_value = metadata_json.encode("utf-8")
        mock_surreal_repo.update_content.return_value = item

        # Execute
        await reprocessor._reprocess_youtube(item, dry_run=False)

        # Verify
        mock_minio_storage.download.assert_called_once_with("youtube/abc123/metadata.json")
        mock_surreal_repo.update_content.assert_called_once()
        updated_item = mock_surreal_repo.update_content.call_args[0][1]
        assert set(updated_item.tags) == {"python", "tutorial", "coding"}
        assert reprocessor.stats["tags_updated"] == 1

    async def test_reprocess_youtube_merges_with_existing_tags(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test YouTube reprocessing merges new tags with existing tags."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="youtube",
            title="Test Video",
            mime_type="text/plain",
            file_size=1000,
            file_path="youtube/abc123/transcript.txt",
            tags=["existing", "tag"],
            metadata={"video_id": "abc123"},
        )

        metadata_json = json.dumps({"tags": ["python", "existing"]})
        mock_minio_storage.download.return_value = metadata_json.encode("utf-8")

        # Execute
        await reprocessor._reprocess_youtube(item, dry_run=False)

        # Verify
        updated_item = mock_surreal_repo.update_content.call_args[0][1]
        assert set(updated_item.tags) == {"existing", "tag", "python"}

    async def test_reprocess_youtube_dry_run_no_updates(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test YouTube reprocessing in dry-run mode doesn't update database."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="youtube",
            title="Test Video",
            mime_type="text/plain",
            file_size=1000,
            file_path="youtube/abc123/transcript.txt",
            tags=[],
            metadata={"video_id": "abc123"},
        )

        metadata_json = json.dumps({"tags": ["python"]})
        mock_minio_storage.download.return_value = metadata_json.encode("utf-8")

        # Execute
        await reprocessor._reprocess_youtube(item, dry_run=True)

        # Verify
        mock_surreal_repo.update_content.assert_not_called()
        assert reprocessor.stats["tags_updated"] == 0

    async def test_reprocess_markdown_extracts_frontmatter_tags(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test markdown reprocessing extracts tags from frontmatter."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="document",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=500,
            file_path="document/test123/note.md",
            tags=[],
        )

        markdown_content = """---
tags:
  - python
  - testing
title: Test Document
---

# Content here
"""
        mock_minio_storage.download.return_value = markdown_content.encode("utf-8")

        # Execute
        await reprocessor._reprocess_markdown(item, dry_run=False)

        # Verify
        updated_item = mock_surreal_repo.update_content.call_args[0][1]
        assert set(updated_item.tags) == {"python", "testing"}
        assert reprocessor.stats["tags_updated"] == 1

    async def test_reprocess_markdown_extracts_and_stores_links(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test markdown reprocessing extracts and stores links."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="document",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=500,
            file_path="document/test123/note.md",
            tags=[],
        )

        markdown_content = """# My Note

This links to [[Other Note]] and [[Another Note]].
"""
        mock_minio_storage.download.return_value = markdown_content.encode("utf-8")
        mock_surreal_repo.find_content_by_title.side_effect = [
            ContentMetadata(
                id="other123",
                content_type="document",
                title="Other Note",
                mime_type="text/markdown",
                file_size=100,
                file_path="document/other123/note.md",
            ),
            None,  # "Another Note" not found
        ]

        # Execute
        await reprocessor._reprocess_markdown(item, dry_run=False)

        # Verify
        mock_surreal_repo.delete_links_by_source.assert_called_once_with("test123")
        assert mock_surreal_repo.create_link.call_count == 2

        # Check first link (resolved)
        first_link = mock_surreal_repo.create_link.call_args_list[0][0][0]
        assert first_link.source == "test123"
        assert first_link.target == "other123"
        assert first_link.link_text == "Other Note"
        assert first_link.link_type == "wiki"

        # Check second link (unresolved)
        second_link = mock_surreal_repo.create_link.call_args_list[1][0][0]
        assert second_link.source == "test123"
        assert second_link.target is None
        assert second_link.link_text == "Another Note"

        assert reprocessor.stats["links_created"] == 2

    async def test_reprocess_markdown_idempotent_deletes_old_links(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test markdown reprocessing deletes old links for idempotency."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="document",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=500,
            file_path="document/test123/note.md",
            tags=[],
        )

        markdown_content = "Links to [[Note]]"
        mock_minio_storage.download.return_value = markdown_content.encode("utf-8")
        mock_surreal_repo.find_content_by_title.return_value = None

        # Execute
        await reprocessor._reprocess_markdown(item, dry_run=False)

        # Verify
        mock_surreal_repo.delete_links_by_source.assert_called_once_with("test123")

    async def test_reprocess_markdown_dry_run_no_database_changes(
        self, reprocessor, mock_minio_storage, mock_surreal_repo
    ):
        """Test markdown reprocessing in dry-run mode doesn't modify database."""
        # Setup
        item = ContentMetadata(
            id="test123",
            content_type="document",
            title="Test Doc",
            mime_type="text/markdown",
            file_size=500,
            file_path="document/test123/note.md",
            tags=[],
        )

        markdown_content = """---
tags: [python]
---

Links to [[Note]]
"""
        mock_minio_storage.download.return_value = markdown_content.encode("utf-8")

        # Execute
        await reprocessor._reprocess_markdown(item, dry_run=True)

        # Verify
        mock_surreal_repo.update_content.assert_not_called()
        mock_surreal_repo.delete_links_by_source.assert_not_called()
        mock_surreal_repo.create_link.assert_not_called()

    async def test_reprocess_all_content_processes_batches(
        self, reprocessor, mock_surreal_repo, mock_minio_storage
    ):
        """Test reprocess_all_content processes content in batches."""
        # Setup
        batch1 = [
            ContentMetadata(
                id=f"item{i}",
                content_type="document",
                title=f"Doc {i}",
                mime_type="text/plain",
                file_size=100,
                file_path=f"doc{i}.txt",
            )
            for i in range(50)
        ]
        batch2 = [
            ContentMetadata(
                id="item50",
                content_type="document",
                title="Doc 50",
                mime_type="text/plain",
                file_size=100,
                file_path="doc50.txt",
            )
        ]

        mock_surreal_repo.list_content.side_effect = [
            (batch1, 51),  # First call: 50 items, total 51
            (batch2, 51),  # Second call: 1 item, total 51
            ([], 51),  # Third call: empty signals end of loop
        ]

        # Execute
        await reprocessor.reprocess_all_content(dry_run=True)

        # Verify
        assert mock_surreal_repo.list_content.call_count == 3
        assert reprocessor.stats["total"] == 51

    async def test_reprocess_handles_errors_gracefully(
        self, reprocessor, mock_surreal_repo, mock_minio_storage
    ):
        """Test reprocessing continues after individual item errors."""
        # Setup
        items = [
            ContentMetadata(
                id="good",
                content_type="youtube",
                title="Good Video",
                mime_type="text/plain",
                file_size=100,
                file_path="youtube/good/transcript.txt",
                metadata={"video_id": "good"},
            ),
            ContentMetadata(
                id="bad",
                content_type="youtube",
                title="Bad Video",
                mime_type="text/plain",
                file_size=100,
                file_path="youtube/bad/transcript.txt",
                metadata={"video_id": "bad"},
            ),
        ]

        mock_surreal_repo.list_content.return_value = (items, 2)

        # First item succeeds, second fails
        mock_minio_storage.download.side_effect = [
            json.dumps({"tags": ["good"]}).encode("utf-8"),
            RuntimeError("MinIO error"),
        ]

        # Execute
        await reprocessor.reprocess_all_content(dry_run=False)

        # Verify
        assert reprocessor.stats["processed"] == 1
        assert reprocessor.stats["errors"] == 1
        assert reprocessor.stats["total"] == 2
