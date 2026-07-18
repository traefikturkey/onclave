"""Unit tests for YouTube service."""

from unittest.mock import MagicMock, patch

import pytest

from menos.services.youtube import TranscriptSegment, YouTubeService, YouTubeTranscript


class TestYouTubeService:
    """Tests for YouTube transcript service."""

    @pytest.fixture
    def service(self) -> YouTubeService:
        """Create a YouTube service with test proxy credentials."""
        return YouTubeService(proxy_username="test_user", proxy_password="test_pass")

    def test_extract_video_id_from_watch_url(self, service: YouTubeService):
        """Test extracting ID from standard watch URL."""
        url = "https://www.youtube.com/watch?v=RpvQH0r0ecM"

        result = service.extract_video_id(url)

        assert result == "RpvQH0r0ecM"

    def test_extract_video_id_from_short_url(self, service: YouTubeService):
        """Test extracting ID from youtu.be short URL."""
        url = "https://youtu.be/RpvQH0r0ecM"

        result = service.extract_video_id(url)

        assert result == "RpvQH0r0ecM"

    def test_extract_video_id_from_embed_url(self, service: YouTubeService):
        """Test extracting ID from embed URL."""
        url = "https://www.youtube.com/embed/RpvQH0r0ecM"

        result = service.extract_video_id(url)

        assert result == "RpvQH0r0ecM"

    def test_extract_video_id_raw_id(self, service: YouTubeService):
        """Test with raw video ID."""
        video_id = "RpvQH0r0ecM"

        result = service.extract_video_id(video_id)

        assert result == "RpvQH0r0ecM"

    def test_extract_video_id_with_params(self, service: YouTubeService):
        """Test extracting ID from URL with extra parameters."""
        url = "https://www.youtube.com/watch?v=RpvQH0r0ecM&t=123&list=xyz"

        result = service.extract_video_id(url)

        assert result == "RpvQH0r0ecM"

    def test_extract_video_id_invalid(self, service: YouTubeService):
        """Test with invalid URL raises error."""
        with pytest.raises(ValueError, match="Could not extract"):
            service.extract_video_id("not-a-valid-url")

    def test_proxy_config_always_set(self, service: YouTubeService):
        """Test proxy config is always initialized."""
        assert service.proxy_config is not None

    @patch("menos.services.youtube.YouTubeTranscriptApi")
    def test_fetch_transcript_request_blocked_error(self, mock_api_cls: MagicMock):
        """Test RequestBlocked error provides actionable proxy message."""
        from youtube_transcript_api._errors import RequestBlocked

        service = YouTubeService(proxy_username="bad_user", proxy_password="bad_pass")
        mock_api = mock_api_cls.return_value
        mock_api.fetch.side_effect = RequestBlocked("test123")

        with pytest.raises(ValueError, match="WEBSHARE_PROXY_USERNAME"):
            service.fetch_transcript("test123")

    @patch("menos.services.youtube.YouTubeTranscriptApi")
    def test_fetch_transcript_request_failed_error(self, mock_api_cls: MagicMock):
        """Test YouTubeRequestFailed error suggests checking proxy config."""
        from requests import HTTPError
        from youtube_transcript_api._errors import YouTubeRequestFailed

        service = YouTubeService(proxy_username="test_user", proxy_password="test_pass")
        mock_api = mock_api_cls.return_value
        mock_api.fetch.side_effect = YouTubeRequestFailed("test123", HTTPError("503"))

        with pytest.raises(ValueError, match="proxy connection issue"):
            service.fetch_transcript("test123")


class TestYouTubeTranscript:
    """Tests for YouTubeTranscript dataclass."""

    def test_full_text(self):
        """Test full_text property."""
        transcript = YouTubeTranscript(
            video_id="test",
            segments=[
                TranscriptSegment(text="Hello", start=0.0, duration=1.0),
                TranscriptSegment(text="world", start=1.0, duration=1.0),
            ],
            language="en",
        )

        assert transcript.full_text == "Hello world"

    def test_timestamped_text(self):
        """Test timestamped_text property."""
        transcript = YouTubeTranscript(
            video_id="test",
            segments=[
                TranscriptSegment(text="Hello", start=0.0, duration=1.0),
                TranscriptSegment(text="world", start=65.5, duration=1.0),
            ],
            language="en",
        )

        result = transcript.timestamped_text

        assert "[00:00] Hello" in result
        assert "[01:05] world" in result
