"""Unit tests for annotations router."""

from unittest.mock import AsyncMock

from menos.models import ContentMetadata


def _make_parent() -> ContentMetadata:
    """Create a parent content item for testing."""
    return ContentMetadata(
        id="parent-1",
        content_type="youtube",
        title="Test Video",
        mime_type="text/plain",
        file_size=1000,
        file_path="youtube/abc123/transcript.txt",
    )


def _make_annotation(ann_id: str = "ann-1", parent_id: str = "parent-1") -> ContentMetadata:
    """Create an annotation content item for testing."""
    return ContentMetadata(
        id=ann_id,
        content_type="annotation",
        title="Slide: Architecture",
        mime_type="text/markdown",
        file_size=500,
        file_path=f"annotations/{parent_id}/{ann_id}.md",
        tags=["architecture"],
        metadata={
            "parent_content_id": parent_id,
            "source_type": "screenshot",
        },
    )


def test_create_annotation_success(authed_client, mock_surreal_repo, mock_minio_storage):
    """Creating an annotation stores in MinIO and creates content record."""
    parent = _make_parent()
    mock_surreal_repo.get_content = AsyncMock(return_value=parent)

    created_annotation = _make_annotation()
    mock_surreal_repo.create_content = AsyncMock(return_value=created_annotation)
    mock_minio_storage.upload = AsyncMock(return_value=500)

    response = authed_client.post(
        "/api/v1/content/parent-1/annotations",
        json={
            "text": "Key points from the architecture slide",
            "title": "Slide: Architecture",
            "source_type": "screenshot",
            "tags": ["architecture"],
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == "ann-1"
    assert data["parent_content_id"] == "parent-1"
    assert data["text"] == "Key points from the architecture slide"
    assert data["title"] == "Slide: Architecture"
    assert data["source_type"] == "screenshot"
    assert data["tags"] == ["architecture"]

    # Verify MinIO upload was called
    mock_minio_storage.upload.assert_called_once()
    call_args = mock_minio_storage.upload.call_args
    assert "annotations/parent-1/" in call_args[0][0]
    assert call_args[0][0].endswith(".md")


def test_create_annotation_parent_not_found(authed_client, mock_surreal_repo):
    """Creating annotation for non-existent parent returns 404."""
    mock_surreal_repo.get_content = AsyncMock(return_value=None)

    response = authed_client.post(
        "/api/v1/content/nonexistent/annotations",
        json={
            "text": "Annotation text",
        },
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Content not found"


def test_create_annotation_stores_in_minio(authed_client, mock_surreal_repo, mock_minio_storage):
    """Annotation text is stored in MinIO with correct path pattern."""
    parent = _make_parent()
    mock_surreal_repo.get_content = AsyncMock(return_value=parent)

    created_annotation = _make_annotation()
    mock_surreal_repo.create_content = AsyncMock(return_value=created_annotation)
    mock_minio_storage.upload = AsyncMock(return_value=500)

    response = authed_client.post(
        "/api/v1/content/parent-1/annotations",
        json={"text": "Test annotation text"},
    )

    assert response.status_code == 200

    # Verify upload called with correct path pattern
    mock_minio_storage.upload.assert_called_once()
    call_args = mock_minio_storage.upload.call_args
    file_path = call_args[0][0]
    assert file_path.startswith("annotations/parent-1/")
    assert file_path.endswith(".md")

    # Verify file content
    file_obj = call_args[0][1]
    content = file_obj.read()
    assert content == b"Test annotation text"

    # Verify mime type
    assert call_args[0][2] == "text/markdown"


def test_create_annotation_sets_metadata_fields(
    authed_client, mock_surreal_repo, mock_minio_storage
):
    """ContentMetadata includes parent_content_id and source_type in metadata dict."""
    parent = _make_parent()
    mock_surreal_repo.get_content = AsyncMock(return_value=parent)

    created_annotation = _make_annotation()
    mock_surreal_repo.create_content = AsyncMock(return_value=created_annotation)
    mock_minio_storage.upload = AsyncMock(return_value=500)

    response = authed_client.post(
        "/api/v1/content/parent-1/annotations",
        json={
            "text": "Annotation text",
            "source_type": "screenshot",
        },
    )

    assert response.status_code == 200

    # Verify create_content called with correct metadata
    mock_surreal_repo.create_content.assert_called_once()
    call_args = mock_surreal_repo.create_content.call_args
    content_metadata = call_args[0][0]

    assert content_metadata.content_type == "annotation"
    assert content_metadata.metadata["parent_content_id"] == "parent-1"
    assert content_metadata.metadata["source_type"] == "screenshot"


def test_list_annotations_empty(authed_client, mock_surreal_repo):
    """Listing annotations for content with none returns empty list."""
    mock_surreal_repo.find_content_by_parent_id = AsyncMock(return_value=[])

    response = authed_client.get("/api/v1/content/parent-1/annotations")

    assert response.status_code == 200
    assert response.json() == []

    # Verify correct query
    mock_surreal_repo.find_content_by_parent_id.assert_called_once_with(
        "parent-1", content_type="annotation"
    )


def test_list_annotations_returns_items(authed_client, mock_surreal_repo, mock_minio_storage):
    """Listing annotations returns items with text loaded from MinIO."""
    ann1 = _make_annotation("ann-1", "parent-1")
    ann2 = _make_annotation("ann-2", "parent-1")
    ann2.title = "Slide: Deployment"
    ann2.tags = ["deployment"]
    ann2.metadata = {
        "parent_content_id": "parent-1",
        "source_type": "screenshot",
    }

    mock_surreal_repo.find_content_by_parent_id = AsyncMock(return_value=[ann1, ann2])

    # Mock MinIO downloads
    async def mock_download(path):
        if "ann-1" in path:
            return b"First annotation text"
        return b"Second annotation text"

    mock_minio_storage.download = AsyncMock(side_effect=mock_download)

    response = authed_client.get("/api/v1/content/parent-1/annotations")

    assert response.status_code == 200
    data = response.json()

    assert len(data) == 2
    assert data[0]["id"] == "ann-1"
    assert data[0]["text"] == "First annotation text"
    assert data[0]["title"] == "Slide: Architecture"
    assert data[0]["source_type"] == "screenshot"
    assert data[0]["tags"] == ["architecture"]

    assert data[1]["id"] == "ann-2"
    assert data[1]["text"] == "Second annotation text"
    assert data[1]["title"] == "Slide: Deployment"
    assert data[1]["tags"] == ["deployment"]

    # Verify MinIO downloads called
    assert mock_minio_storage.download.call_count == 2
