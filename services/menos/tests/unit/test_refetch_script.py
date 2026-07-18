"""Unit tests for scripts/refetch_metadata.py."""

import contextlib
import io
import json
import logging
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from menos.models import ContentMetadata
from menos.services.youtube_metadata import YouTubeMetadata


def make_content_item(
    item_id: str = "content:abc",
    video_id: str = "dQw4w9WgXcQ",
    *,
    metadata: dict | None = None,
    file_size: int = 5000,
    author: str = "test-user",
    created_at: datetime | None = None,
) -> ContentMetadata:
    """Build a ContentMetadata fixture for a YouTube video."""
    if metadata is None:
        metadata = {"video_id": video_id, "language": "en", "segment_count": 42}
    return ContentMetadata(
        id=item_id,
        content_type="youtube",
        title="Old Title",
        mime_type="text/plain",
        file_size=file_size,
        file_path=f"youtube/{video_id}/transcript.txt",
        author=author,
        created_at=created_at or datetime(2025, 1, 15, 12, 0, 0),
        metadata=metadata,
    )


def make_yt_metadata(video_id: str = "dQw4w9WgXcQ") -> YouTubeMetadata:
    """Build a YouTubeMetadata fixture."""
    return YouTubeMetadata(
        video_id=video_id,
        title="Never Gonna Give You Up",
        description="Official music video https://example.com/link",
        description_urls=["https://example.com/link"],
        channel_id="UCuAXFkgsw1L7xaCfnd5JJOw",
        channel_title="Rick Astley",
        published_at="2009-10-25T06:57:33Z",
        duration="PT3M33S",
        duration_seconds=213,
        duration_formatted="3:33",
        view_count=1_500_000_000,
        like_count=15_000_000,
        comment_count=3_000_000,
        tags=["rick astley", "never gonna give you up"],
        category_id="10",
        thumbnails={"default": {"url": "https://i.ytimg.com/vi/thumb.jpg"}},
        fetched_at="2025-06-01T12:00:00",
    )


MODULE = "scripts.refetch_metadata"


@pytest.fixture
def mock_minio():
    """Mock MinIO storage with download/upload."""
    m = MagicMock()
    m.download = AsyncMock(return_value=b"Hello this is a transcript.")
    m.upload = AsyncMock()
    return m


@pytest.fixture
def mock_surreal():
    """Mock SurrealDB repository with list_content and db.query."""
    s = MagicMock()
    s.list_content = AsyncMock(return_value=([], 0))
    s.db = MagicMock()
    return s


@pytest.fixture
def mock_settings():
    """Mock settings."""
    return MagicMock()


@pytest.fixture
def mock_metadata_service():
    """Mock YouTubeMetadataService."""
    svc = MagicMock()
    svc.fetch_metadata = MagicMock(return_value=make_yt_metadata())
    return svc


@pytest.fixture
def patched_refetch(mock_minio, mock_surreal, mock_settings, mock_metadata_service):
    """Patch all external deps for refetch_all and return mocks dict."""

    @contextlib.asynccontextmanager
    async def mock_storage_context():
        yield (mock_minio, mock_surreal)

    with (
        patch(f"{MODULE}.get_storage_context", mock_storage_context),
        patch(f"{MODULE}.YouTubeMetadataService", return_value=mock_metadata_service),
    ):
        yield {
            "minio": mock_minio,
            "surreal": mock_surreal,
            "settings": mock_settings,
            "metadata_service": mock_metadata_service,
        }


class TestRefetchAll:
    """Tests for the refetch_all function."""

    @pytest.mark.asyncio
    async def test_processes_all_youtube_videos(self, patched_refetch):
        """Two items returned — both should be processed."""
        mocks = patched_refetch
        item_a = make_content_item("content:a", "vid_AAA")
        item_b = make_content_item("content:b", "vid_BBB")
        mocks["surreal"].list_content.return_value = ([item_a, item_b], 2)
        mocks["metadata_service"].fetch_metadata.side_effect = [
            make_yt_metadata("vid_AAA"),
            make_yt_metadata("vid_BBB"),
        ]

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        assert mocks["metadata_service"].fetch_metadata.call_count == 2
        assert mocks["minio"].upload.call_count == 2  # 2 metadata.json
        assert mocks["surreal"].db.query.call_count == 2

    @pytest.mark.asyncio
    async def test_skips_items_without_video_id(self, patched_refetch, caplog):
        """Item with empty metadata should be skipped with a warning."""
        mocks = patched_refetch
        item = make_content_item("content:noid", "", metadata={})
        mocks["surreal"].list_content.return_value = ([item], 1)

        from scripts.refetch_metadata import refetch_all

        with caplog.at_level(logging.WARNING):
            await refetch_all()

        assert "Skipping item content:noid" in caplog.text
        mocks["metadata_service"].fetch_metadata.assert_not_called()

    @pytest.mark.asyncio
    async def test_fetches_metadata_from_youtube_api(self, patched_refetch):
        """fetch_metadata should be called with the correct video_id."""
        mocks = patched_refetch
        item = make_content_item(video_id="xyzABC123_0")
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["metadata_service"].fetch_metadata.return_value = make_yt_metadata("xyzABC123_0")

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        mocks["metadata_service"].fetch_metadata.assert_called_once_with("xyzABC123_0")

    @pytest.mark.asyncio
    async def test_handles_metadata_fetch_failure(self, patched_refetch, caplog):
        """When fetch_metadata raises, skip item and continue."""
        mocks = patched_refetch
        item = make_content_item()
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["metadata_service"].fetch_metadata.side_effect = ValueError("API error")

        from scripts.refetch_metadata import refetch_all

        with caplog.at_level(logging.ERROR):
            await refetch_all()

        assert "Failed to fetch metadata" in caplog.text
        mocks["minio"].download.assert_not_called()

    @pytest.mark.asyncio
    async def test_reads_transcript_from_minio(self, patched_refetch):
        """download should be called with the correct transcript path."""
        mocks = patched_refetch
        item = make_content_item(video_id="tr_TEST")
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["metadata_service"].fetch_metadata.return_value = make_yt_metadata("tr_TEST")

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        mocks["minio"].download.assert_called_once_with("youtube/tr_TEST/transcript.txt")

    @pytest.mark.asyncio
    async def test_handles_transcript_read_failure(self, patched_refetch, caplog):
        """When transcript download fails, skip item and continue."""
        mocks = patched_refetch
        item = make_content_item()
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["minio"].download.side_effect = Exception("MinIO down")

        from scripts.refetch_metadata import refetch_all

        with caplog.at_level(logging.ERROR):
            await refetch_all()

        assert "Failed to read transcript" in caplog.text
        mocks["minio"].upload.assert_not_called()

    @pytest.mark.asyncio
    async def test_uploads_metadata_json_to_minio(self, patched_refetch):
        """metadata.json should be uploaded to the correct path."""
        mocks = patched_refetch
        item = make_content_item(video_id="up_META")
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["metadata_service"].fetch_metadata.return_value = make_yt_metadata("up_META")

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        # First upload call is metadata.json
        calls = mocks["minio"].upload.call_args_list
        meta_call = calls[0]
        assert meta_call[0][0] == "youtube/up_META/metadata.json"
        assert meta_call[0][2] == "application/json"

    @pytest.mark.asyncio
    async def test_metadata_json_contains_all_fields(self, patched_refetch):
        """Uploaded metadata JSON should contain all expected keys."""
        mocks = patched_refetch
        item = make_content_item(video_id="fld_CHECK")
        mocks["surreal"].list_content.return_value = ([item], 1)
        yt = make_yt_metadata("fld_CHECK")
        mocks["metadata_service"].fetch_metadata.return_value = yt

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        # Extract the BytesIO passed to upload
        meta_call = mocks["minio"].upload.call_args_list[0]
        uploaded_bytes_io: io.BytesIO = meta_call[0][1]
        uploaded_bytes_io.seek(0)
        data = json.loads(uploaded_bytes_io.read().decode("utf-8"))

        expected_keys = {
            "id",
            "video_id",
            "title",
            "description",
            "description_urls",
            "channel_id",
            "channel_title",
            "published_at",
            "duration",
            "duration_seconds",
            "view_count",
            "like_count",
            "tags",
            "thumbnails",
            "language",
            "segment_count",
            "transcript_length",
            "file_size",
            "author",
            "created_at",
            "fetched_at",
        }
        assert set(data.keys()) == expected_keys
        assert data["video_id"] == "fld_CHECK"
        assert data["title"] == yt.title
        assert data["channel_title"] == yt.channel_title

    @pytest.mark.asyncio
    async def test_updates_title_in_surrealdb(self, patched_refetch):
        """surreal.db.query should be called with UPDATE statement."""
        from surrealdb import RecordID

        mocks = patched_refetch
        item = make_content_item(item_id="content:db_up")
        mocks["surreal"].list_content.return_value = ([item], 1)
        yt = make_yt_metadata()
        mocks["metadata_service"].fetch_metadata.return_value = yt

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        mocks["surreal"].db.query.assert_called_once()
        call_args = mocks["surreal"].db.query.call_args
        assert "UPDATE content SET" in call_args[0][0]
        params = call_args[0][1]
        assert params["title"] == yt.title
        assert params["tags"] == yt.tags
        # ID should be a RecordID object with table_name and id
        assert isinstance(params["id"], RecordID)
        assert params["id"].table_name == "content"
        assert params["id"].id == "db_up"
        assert params["metadata"]["channel_title"] == yt.channel_title
        assert params["metadata"]["published_at"] == yt.published_at

    @pytest.mark.asyncio
    async def test_handles_surrealdb_update_failure(self, patched_refetch, caplog):
        """SurrealDB update failure should be logged but not crash."""
        mocks = patched_refetch
        item = make_content_item()
        mocks["surreal"].list_content.return_value = ([item], 1)
        mocks["surreal"].db.query.side_effect = Exception("DB down")

        from scripts.refetch_metadata import refetch_all

        with caplog.at_level(logging.ERROR):
            await refetch_all()

        assert "Failed to update SurrealDB" in caplog.text

    @pytest.mark.asyncio
    async def test_empty_video_list(self, patched_refetch):
        """No items returned — no processing should occur."""
        mocks = patched_refetch
        mocks["surreal"].list_content.return_value = ([], 0)

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        mocks["metadata_service"].fetch_metadata.assert_not_called()
        mocks["minio"].download.assert_not_called()
        mocks["minio"].upload.assert_not_called()
        mocks["surreal"].db.query.assert_not_called()

    @pytest.mark.asyncio
    async def test_normalizes_recordid_with_table_prefix(self, patched_refetch):
        """Item ID with 'content:' prefix should be split, RecordID created."""
        from surrealdb import RecordID

        mocks = patched_refetch
        # Item ID includes the table prefix
        item = make_content_item(item_id="content:abc123xyz")
        mocks["surreal"].list_content.return_value = ([item], 1)

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        # Verify that db.query was called with a RecordID object
        mocks["surreal"].db.query.assert_called_once()
        call_args = mocks["surreal"].db.query.call_args
        params = call_args[0][1]

        # The "id" parameter must be a RecordID object with correct parts
        assert isinstance(params["id"], RecordID)
        assert params["id"].table_name == "content"
        assert params["id"].id == "abc123xyz"

    @pytest.mark.asyncio
    async def test_normalizes_recordid_without_prefix(self, patched_refetch):
        """Item ID without prefix should still work with RecordID."""
        from surrealdb import RecordID

        mocks = patched_refetch
        # Item ID without the table prefix
        item = make_content_item(item_id="plain_id_456")
        mocks["surreal"].list_content.return_value = ([item], 1)

        from scripts.refetch_metadata import refetch_all

        await refetch_all()

        # Verify that db.query was called with a RecordID object
        mocks["surreal"].db.query.assert_called_once()
        call_args = mocks["surreal"].db.query.call_args
        params = call_args[0][1]

        # The "id" parameter must be a RecordID object
        assert isinstance(params["id"], RecordID)
        assert params["id"].table_name == "content"
        assert params["id"].id == "plain_id_456"
