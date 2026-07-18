"""Integration tests for YouTube-related unified content endpoint behavior."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

from menos.models import ContentMetadata


class TestYouTubeContentFiltering:
    """Tests for filtering YouTube content via unified content endpoint."""

    def test_list_youtube_content_via_unified_endpoint(self, authed_client, mock_surreal_repo):
        """Test listing YouTube content via GET /api/v1/content?content_type=youtube."""
        video1 = ContentMetadata(
            id="content1",
            content_type="youtube",
            title="Video 1",
            mime_type="text/plain",
            file_size=1000,
            file_path="youtube/vid1/transcript.txt",
            author="test_user",
            metadata={
                "video_id": "vid1",
                "channel_id": "channel_a",
                "channel_title": "Channel A",
            },
            created_at=datetime.now(UTC),
        )
        video2 = ContentMetadata(
            id="content2",
            content_type="youtube",
            title="Video 2",
            mime_type="text/plain",
            file_size=2000,
            file_path="youtube/vid2/transcript.txt",
            author="test_user",
            metadata={
                "video_id": "vid2",
                "channel_id": "channel_b",
                "channel_title": "Channel B",
            },
            created_at=datetime.now(UTC),
        )

        mock_surreal_repo.list_content = AsyncMock(return_value=([video1, video2], 2))

        response = authed_client.get("/api/v1/content?content_type=youtube")

        assert response.status_code == 200
        data = response.json()
        assert len(data["items"]) == 2
        assert data["items"][0]["id"] == "content1"
        assert data["items"][1]["id"] == "content2"
