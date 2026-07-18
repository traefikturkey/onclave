"""Smoke tests for YouTube content via unified endpoints."""

import pytest


@pytest.mark.smoke
class TestYouTubeSmoke:
    """Smoke tests for YouTube content access via unified endpoints."""

    def test_content_list_with_youtube_filter(self, smoke_authed_get):
        """GET /api/v1/content?content_type=youtube returns YouTube content."""
        response = smoke_authed_get("/api/v1/content?content_type=youtube")
        assert response.status_code == 200

        data = response.json()
        assert "items" in data
        assert isinstance(data["items"], list)

    def test_content_list_youtube_item_structure(self, smoke_authed_get):
        """GET /api/v1/content?content_type=youtube items have expected structure."""
        response = smoke_authed_get("/api/v1/content?content_type=youtube&exclude_tags=")
        assert response.status_code == 200

        data = response.json()
        items = data["items"]
        if items:
            first = items[0]
            assert isinstance(first["id"], str)
            assert first["content_type"] == "youtube"
            assert isinstance(first["title"], str)
            # YouTube metadata should be in metadata field
            if first.get("metadata"):
                metadata = first["metadata"]
                if "video_id" in metadata:
                    assert isinstance(metadata["video_id"], str)

    def test_content_get_youtube_by_id(self, smoke_authed_get, smoke_first_youtube_content_id):
        """GET /api/v1/content/{id} returns YouTube content details."""
        response = smoke_authed_get(f"/api/v1/content/{smoke_first_youtube_content_id}")
        assert response.status_code == 200

        content = response.json()
        assert content["content_type"] == "youtube"
        assert isinstance(content["id"], str)
        # Pipeline fields may be None if not yet processed
        assert "summary" in content
        assert "quality_tier" in content

    def test_content_download_youtube_transcript(
        self, smoke_authed_get, smoke_first_youtube_content_id
    ):
        """GET /api/v1/content/{id}/download returns YouTube transcript."""
        response = smoke_authed_get(f"/api/v1/content/{smoke_first_youtube_content_id}/download")
        assert response.status_code == 200
        assert "text/plain" in response.headers.get("content-type", "")
        assert len(response.text) > 0

    def test_content_get_not_found(self, smoke_authed_get):
        """GET /api/v1/content/{id} returns 404 for unknown content."""
        response = smoke_authed_get("/api/v1/content/NONEXISTENT99")
        assert response.status_code == 404
