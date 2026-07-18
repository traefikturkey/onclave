"""Unit tests for unified ingest router."""

from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from menos.models import ContentMetadata
from menos.routers.ingest import _has_incomplete_metadata, canonicalize_web_url
from menos.services.docling import DoclingResult
from menos.services.url_detector import DetectedURL
from menos.services.youtube import TranscriptSegment, YouTubeTranscript
from menos.services.youtube_metadata import YouTubeMetadata


def _youtube_transcript() -> YouTubeTranscript:
    return YouTubeTranscript(
        video_id="dQw4w9WgXcQ",
        language="en",
        segments=[TranscriptSegment(text="hello", start=0.0, duration=1.0)],
    )


def _youtube_metadata() -> YouTubeMetadata:
    return YouTubeMetadata(
        video_id="dQw4w9WgXcQ",
        title="Rick Astley - Never Gonna Give You Up",
        description="The official video",
        description_urls=["https://example.com"],
        channel_id="UCuAXFkgsw1L7xaCfnd5JJOw",
        channel_title="Rick Astley",
        published_at="2009-10-25T06:57:33Z",
        duration="PT3M33S",
        duration_seconds=213,
        duration_formatted="3:33",
        view_count=1500000000,
        like_count=15000000,
        comment_count=3000000,
        tags=["rick astley", "never gonna give you up"],
        category_id="10",
        thumbnails={},
        fetched_at="2026-02-14T12:00:00",
    )


def test_ingest_youtube_fetches_metadata_and_stores_rich_fields(
    authed_client,
    mock_surreal_repo,
    mock_youtube_service,
    mock_metadata_service,
    mock_minio_storage,
    mock_docling_client,
    mock_pipeline_orchestrator,
):
    yt_meta = _youtube_metadata()
    mock_youtube_service.fetch_transcript.return_value = _youtube_transcript()
    mock_metadata_service.fetch_metadata.return_value = yt_meta
    mock_surreal_repo.find_content_by_video_id = AsyncMock(return_value=None)
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="content-y1",
        content_type="youtube",
        title=yt_meta.title,
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    mock_pipeline_orchestrator.submit = AsyncMock(return_value=MagicMock(id="job-y1"))

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Rick Astley - Never Gonna Give You Up"
    assert data["job_id"] == "job-y1"

    # Verify metadata was fetched
    mock_metadata_service.fetch_metadata.assert_called_once_with("dQw4w9WgXcQ")

    # Verify create_content was called with rich metadata
    call_args = mock_surreal_repo.create_content.await_args[0][0]
    assert call_args.metadata["published_at"] == "2009-10-25T06:57:33Z"
    assert call_args.metadata["channel_id"] == "UCuAXFkgsw1L7xaCfnd5JJOw"
    assert call_args.metadata["channel_title"] == "Rick Astley"
    assert call_args.metadata["duration_seconds"] == 213
    assert call_args.metadata["view_count"] == 1500000000
    assert set(call_args.tags) == {"rick astley", "never gonna give you up"}

    # Verify metadata.json was uploaded to MinIO (2 uploads: transcript + metadata.json)
    assert mock_minio_storage.upload.await_count == 2
    metadata_upload = mock_minio_storage.upload.await_args_list[1]
    assert metadata_upload.args[0] == "youtube/dQw4w9WgXcQ/metadata.json"

    # Docling should not be called
    assert mock_docling_client.extract_markdown.await_count == 0


def test_ingest_youtube_gracefully_handles_metadata_failure(
    authed_client,
    mock_surreal_repo,
    mock_youtube_service,
    mock_metadata_service,
    mock_minio_storage,
    mock_pipeline_orchestrator,
):
    mock_youtube_service.fetch_transcript.return_value = _youtube_transcript()
    mock_metadata_service.fetch_metadata.side_effect = ValueError(
        "YouTube API key not configured"
    )
    mock_surreal_repo.find_content_by_video_id = AsyncMock(return_value=None)
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="content-y2",
        content_type="youtube",
        title="YouTube: dQw4w9WgXcQ",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    mock_pipeline_orchestrator.submit = AsyncMock(return_value=MagicMock(id="job-y2"))

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "YouTube: dQw4w9WgXcQ"
    assert data["job_id"] == "job-y2"

    # Verify fallback metadata has None fields
    call_args = mock_surreal_repo.create_content.await_args[0][0]
    assert call_args.metadata["published_at"] is None
    assert call_args.metadata["channel_id"] is None
    assert call_args.tags == []


def test_ingest_routes_web_urls_to_docling_flow(
    authed_client,
    mock_surreal_repo,
    mock_docling_client,
    mock_pipeline_orchestrator,
    mock_minio_storage,
):
    url = "https://www.Example.com/article/?b=2&utm_source=x&a=1#section"
    canonical = canonicalize_web_url(url)

    mock_docling_client.extract_markdown = AsyncMock(
        return_value=DoclingResult(markdown="# Web Title\nBody", title="Web Title")
    )
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="content-w1",
        content_type="web",
        title="Web Title",
        mime_type="text/markdown",
        file_size=100,
        file_path="web/hash/content.md",
    )
    mock_pipeline_orchestrator.submit = AsyncMock(return_value=MagicMock(id="job-w1"))

    response = authed_client.post("/api/v1/ingest", json={"url": url})

    assert response.status_code == 200
    assert response.json() == {
        "content_id": "content-w1",
        "content_type": "web",
        "title": "Web Title",
        "job_id": "job-w1",
    }
    mock_docling_client.extract_markdown.assert_awaited_once()
    called_url = mock_docling_client.extract_markdown.await_args.args[0]
    assert called_url == "https://www.example.com/article/?b=2&utm_source=x&a=1#section"
    uploaded_path = mock_minio_storage.upload.await_args.args[0]
    assert uploaded_path.endswith("/content.md")
    assert canonical == "https://example.com/article?a=1&b=2"


def test_ingest_unknown_classification_falls_back_to_docling(
    authed_client,
    mock_docling_client,
    mock_surreal_repo,
):
    mock_docling_client.extract_markdown = AsyncMock(
        return_value=DoclingResult(markdown="# Unknown\nBody", title="Unknown")
    )
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="content-u1",
        content_type="web",
        title="Unknown",
        mime_type="text/markdown",
        file_size=100,
        file_path="web/hash/content.md",
    )

    with patch(
        "menos.routers.ingest.URLDetector.classify_url",
        return_value=DetectedURL(
            url="https://example.com", url_type="unknown", extracted_id=""
        ),
    ):
        response = authed_client.post(
            "/api/v1/ingest", json={"url": "https://example.com"}
        )

    assert response.status_code == 200
    assert response.json()["content_type"] == "web"
    assert mock_docling_client.extract_markdown.await_count == 1


def test_ingest_dedupe_returns_existing_content_and_no_enqueue(
    authed_client,
    mock_surreal_repo,
    mock_docling_client,
    mock_pipeline_orchestrator,
):
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(
        return_value=ContentMetadata(
            id="existing-1",
            content_type="web",
            title="Existing",
            mime_type="text/markdown",
            file_size=10,
            file_path="web/existing/content.md",
        )
    )

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://example.com/path"}
    )

    assert response.status_code == 200
    assert response.json() == {
        "content_id": "existing-1",
        "content_type": "web",
        "title": "Existing",
        "job_id": None,
    }
    assert mock_docling_client.extract_markdown.await_count == 0
    assert mock_pipeline_orchestrator.submit.await_count == 0


def test_ingest_returns_docling_errors(
    authed_client,
    mock_docling_client,
):
    mock_docling_client.extract_markdown = AsyncMock(
        side_effect=HTTPException(status_code=503, detail="Docling service unavailable")
    )

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://example.com/fail"}
    )

    assert response.status_code == 503


def test_ingest_rejects_invalid_url(authed_client):
    response = authed_client.post("/api/v1/ingest", json={"url": "notaurl"})
    assert response.status_code == 422


def test_canonicalization_is_deterministic_and_strips_tracking():
    url_a = "https://WWW.Example.com/path/?b=2&utm_source=abc&A=1&fbclid=123&gBraId=456#frag"
    url_b = "https://example.com/path?A=1&b=2"

    canonical_a = canonicalize_web_url(url_a)
    canonical_b = canonicalize_web_url(url_b)

    assert canonical_a == canonical_b
    assert canonical_a == "https://example.com/path?A=1&b=2"
    assert "utm_source" not in canonical_a
    assert "fbclid" not in canonical_a
    assert "gBraId" not in canonical_a


def test_legacy_youtube_ingest_endpoint_is_removed(authed_client):
    """Legacy YouTube ingest endpoint should return 404 (route removed)."""
    response = authed_client.post(
        "/api/v1/youtube/ingest",
        json={"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
    )
    assert response.status_code == 404


# --- _has_incomplete_metadata unit tests ---


def test_has_incomplete_metadata_placeholder_title():
    record = ContentMetadata(
        id="abc",
        content_type="youtube",
        title="YouTube: dQw4w9WgXcQ",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
        metadata={},
    )
    assert _has_incomplete_metadata(record, "dQw4w9WgXcQ") is True


def test_has_incomplete_metadata_no_title():
    record = ContentMetadata(
        id="abc",
        content_type="youtube",
        title=None,
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    assert _has_incomplete_metadata(record, "dQw4w9WgXcQ") is True


def test_has_incomplete_metadata_missing_channel_title():
    record = ContentMetadata(
        id="abc",
        content_type="youtube",
        title="Some Real Title",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
        metadata={"language": "en"},
    )
    assert _has_incomplete_metadata(record, "dQw4w9WgXcQ") is True


def test_has_incomplete_metadata_complete_record():
    record = ContentMetadata(
        id="abc",
        content_type="youtube",
        title="Rick Astley - Never Gonna Give You Up",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
        metadata={"channel_title": "Rick Astley"},
    )
    assert _has_incomplete_metadata(record, "dQw4w9WgXcQ") is False


def test_has_incomplete_metadata_no_record():
    assert _has_incomplete_metadata(None, "dQw4w9WgXcQ") is False


def test_has_incomplete_metadata_no_id():
    record = ContentMetadata(
        content_type="youtube",
        title="YouTube: dQw4w9WgXcQ",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    assert _has_incomplete_metadata(record, "dQw4w9WgXcQ") is False


# --- Backfill path integration tests ---


def _existing_record_with_placeholder(video_id: str = "dQw4w9WgXcQ") -> ContentMetadata:
    return ContentMetadata(
        id="existing-yt1",
        content_type="youtube",
        title=f"YouTube: {video_id}",
        mime_type="text/plain",
        file_size=500,
        file_path=f"youtube/{video_id}/transcript.txt",
        author="test-key",
        metadata={
            "video_id": video_id,
            "language": "en",
            "segment_count": 42,
            "resource_key": f"yt:{video_id}",
        },
    )


def test_backfill_triggered_by_placeholder_title(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
    mock_minio_storage,
):
    existing = _existing_record_with_placeholder()
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)
    mock_surreal_repo.db = MagicMock()
    mock_metadata_service.fetch_metadata.return_value = _youtube_metadata()
    mock_minio_storage.download = AsyncMock(return_value=b"transcript text here")

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Rick Astley - Never Gonna Give You Up"
    assert data["content_id"] == "existing-yt1"
    assert data["job_id"] is None

    # Verify DB update was called with RecordID
    mock_surreal_repo.db.query.assert_called_once()
    call_args = mock_surreal_repo.db.query.call_args
    assert "UPDATE content SET" in call_args[0][0]
    params = call_args[0][1]
    assert params["title"] == "Rick Astley - Never Gonna Give You Up"
    assert params["tags"] == ["rick astley", "never gonna give you up"]

    # Verify metadata.json uploaded to MinIO
    upload_calls = mock_minio_storage.upload.await_args_list
    assert any("metadata.json" in str(c) for c in upload_calls)


def test_backfill_preserves_existing_metadata_fields(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
    mock_minio_storage,
):
    existing = _existing_record_with_placeholder()
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)
    mock_surreal_repo.db = MagicMock()
    mock_metadata_service.fetch_metadata.return_value = _youtube_metadata()
    mock_minio_storage.download = AsyncMock(return_value=b"transcript")

    authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    # Verify the merged metadata preserves original fields
    call_args = mock_surreal_repo.db.query.call_args
    merged_meta = call_args[0][1]["metadata"]
    assert merged_meta["language"] == "en"
    assert merged_meta["segment_count"] == 42
    assert merged_meta["resource_key"] == "yt:dQw4w9WgXcQ"
    # And includes new YouTube API fields
    assert merged_meta["channel_title"] == "Rick Astley"
    assert merged_meta["channel_id"] == "UCuAXFkgsw1L7xaCfnd5JJOw"
    assert merged_meta["published_at"] == "2009-10-25T06:57:33Z"


def test_backfill_metadata_fetch_failure_returns_existing(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
):
    existing = _existing_record_with_placeholder()
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)
    mock_metadata_service.fetch_metadata.side_effect = ValueError("API key not configured")

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "YouTube: dQw4w9WgXcQ"
    assert data["content_id"] == "existing-yt1"
    assert data["job_id"] is None


def test_backfill_db_update_failure_returns_stale_data(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
):
    existing = _existing_record_with_placeholder()
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)
    mock_surreal_repo.db = MagicMock()
    mock_surreal_repo.db.query.side_effect = RuntimeError("DB connection lost")
    mock_metadata_service.fetch_metadata.return_value = _youtube_metadata()

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    # Falls back to existing stale title
    assert data["title"] == "YouTube: dQw4w9WgXcQ"
    assert data["content_id"] == "existing-yt1"


def test_complete_youtube_record_skips_backfill(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
    mock_youtube_service,
):
    existing = ContentMetadata(
        id="existing-yt2",
        content_type="youtube",
        title="Rick Astley - Never Gonna Give You Up",
        mime_type="text/plain",
        file_size=500,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
        metadata={"channel_title": "Rick Astley", "language": "en"},
    )
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["content_id"] == "existing-yt2"
    assert data["title"] == "Rick Astley - Never Gonna Give You Up"
    assert data["job_id"] is None

    # No metadata fetch, no DB update, no transcript fetch
    mock_metadata_service.fetch_metadata.assert_not_called()
    mock_youtube_service.fetch_transcript.assert_not_called()


def test_backfill_minio_failure_still_succeeds(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
    mock_minio_storage,
):
    """MinIO metadata.json upload failure is non-fatal (DB is source of truth)."""
    existing = _existing_record_with_placeholder()
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=existing)
    mock_surreal_repo.db = MagicMock()
    mock_metadata_service.fetch_metadata.return_value = _youtube_metadata()
    mock_minio_storage.download = AsyncMock(return_value=b"transcript")
    mock_minio_storage.upload = AsyncMock(side_effect=RuntimeError("MinIO down"))

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    # DB update succeeded, so we get the new title
    assert data["title"] == "Rick Astley - Never Gonna Give You Up"


# --- video_id fallback deduplication tests ---


def test_video_id_fallback_finds_old_record_without_resource_key(
    authed_client,
    mock_surreal_repo,
    mock_metadata_service,
    mock_youtube_service,
):
    """When resource_key lookup misses, fallback to video_id lookup for old records."""
    old_record = ContentMetadata(
        id="old-yt-1",
        content_type="youtube",
        title="Rick Astley - Never Gonna Give You Up",
        mime_type="text/plain",
        file_size=500,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
        metadata={"video_id": "dQw4w9WgXcQ", "channel_title": "Rick Astley"},
    )

    # resource_key lookup misses, video_id lookup hits
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=None)
    mock_surreal_repo.find_content_by_video_id = AsyncMock(return_value=old_record)
    mock_surreal_repo.db = MagicMock()

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["content_id"] == "old-yt-1"
    assert data["title"] == "Rick Astley - Never Gonna Give You Up"
    assert data["job_id"] is None

    # Verify fallback was called
    mock_surreal_repo.find_content_by_video_id.assert_awaited_once_with("dQw4w9WgXcQ")

    # Verify resource_key backfill query was executed
    mock_surreal_repo.db.query.assert_called_once()
    call_args = mock_surreal_repo.db.query.call_args
    assert "UPDATE content SET metadata.resource_key" in call_args[0][0]
    params = call_args[0][1]
    assert params["resource_key"] == "yt:dQw4w9WgXcQ"

    # No new transcript fetch or metadata fetch
    mock_youtube_service.fetch_transcript.assert_not_called()
    mock_metadata_service.fetch_metadata.assert_not_called()


def test_video_id_fallback_miss_proceeds_to_new_ingest(
    authed_client,
    mock_surreal_repo,
    mock_youtube_service,
    mock_metadata_service,
    mock_pipeline_orchestrator,
):
    """When both resource_key and video_id lookups miss, proceed to create new record."""
    # Both lookups return None
    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=None)
    mock_surreal_repo.find_content_by_video_id = AsyncMock(return_value=None)
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="new-yt-1",
        content_type="youtube",
        title="Rick Astley - Never Gonna Give You Up",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    mock_youtube_service.fetch_transcript.return_value = _youtube_transcript()
    mock_metadata_service.fetch_metadata.return_value = _youtube_metadata()
    mock_pipeline_orchestrator.submit = AsyncMock(return_value=MagicMock(id="job-new"))

    response = authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/dQw4w9WgXcQ"}
    )

    assert response.status_code == 200
    data = response.json()
    assert data["content_id"] == "new-yt-1"
    assert data["job_id"] == "job-new"

    # Verify both fallback and new ingestion were attempted
    mock_surreal_repo.find_content_by_video_id.assert_awaited_once_with("dQw4w9WgXcQ")
    mock_youtube_service.fetch_transcript.assert_called_once()
    mock_surreal_repo.create_content.assert_awaited_once()


def test_resource_key_backfill_uses_recordid(
    authed_client,
    mock_surreal_repo,
):
    """Verify resource_key backfill uses RecordID, not plain string."""
    old_record = ContentMetadata(
        id="abc123",
        content_type="youtube",
        title="Test Video",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/ABCDefgh123/transcript.txt",
        metadata={"video_id": "ABCDefgh123", "channel_title": "Test"},
    )

    mock_surreal_repo.find_content_by_resource_key = AsyncMock(return_value=None)
    mock_surreal_repo.find_content_by_video_id = AsyncMock(return_value=old_record)
    mock_surreal_repo.db = MagicMock()

    authed_client.post(
        "/api/v1/ingest", json={"url": "https://youtu.be/ABCDefgh123"}
    )

    # Extract the RecordID from the call
    call_args = mock_surreal_repo.db.query.call_args
    params = call_args[0][1]
    record_id = params["id"]

    # Verify it's a RecordID object, not a string
    from surrealdb import RecordID
    assert isinstance(record_id, RecordID)
    assert str(record_id) == "content:abc123"


def test_ingest_youtube_from_local_transcript_skips_server_transcript_fetch(
    authed_client,
    mock_surreal_repo,
    mock_youtube_service,
    mock_metadata_service,
    mock_minio_storage,
    mock_pipeline_orchestrator,
):
    mock_metadata_service.fetch_metadata.side_effect = ValueError("metadata unavailable")
    mock_surreal_repo.create_content.return_value = ContentMetadata(
        id="content-local",
        content_type="youtube",
        title="Client Title",
        mime_type="text/plain",
        file_size=100,
        file_path="youtube/dQw4w9WgXcQ/transcript.txt",
    )
    mock_pipeline_orchestrator.submit = AsyncMock(return_value=MagicMock(id="job-local"))

    response = authed_client.post(
        "/api/v1/ingest",
        json={
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "transcript_text": "local transcript text",
            "transcript_format": "plain",
            "metadata": {"title": "Client Title", "channel_title": "Client Channel"},
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["title"] == "Client Title"
    assert data["job_id"] == "job-local"
    mock_youtube_service.fetch_transcript.assert_not_called()
    first_upload = mock_minio_storage.upload.await_args_list[0]
    assert first_upload.args[0] == "youtube/dQw4w9WgXcQ/transcript.txt"
    created = mock_surreal_repo.create_content.await_args[0][0]
    assert created.metadata["channel_title"] == "Client Channel"
    mock_pipeline_orchestrator.submit.assert_awaited_once()
    assert mock_pipeline_orchestrator.submit.await_args.args[1] == "local transcript text"


def test_ingest_youtube_rejects_empty_local_transcript(authed_client):
    response = authed_client.post(
        "/api/v1/ingest",
        json={
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "transcript_text": "   ",
            "transcript_format": "plain",
        },
    )

    assert response.status_code == 422


def test_ingest_youtube_rejects_oversize_local_transcript(authed_client):
    response = authed_client.post(
        "/api/v1/ingest",
        json={
            "url": "https://youtu.be/dQw4w9WgXcQ",
            "transcript_text": "x" * (5 * 1024 * 1024 + 1),
            "transcript_format": "plain",
        },
    )

    assert response.status_code == 413
