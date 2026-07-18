"""Unit tests for YouTube metadata service."""

from unittest.mock import MagicMock, patch

import pytest

from menos.services.youtube_metadata import (
    YouTubeChannelVideo,
    YouTubeMetadata,
    YouTubeMetadataService,
    extract_urls,
    format_duration,
    parse_duration_to_seconds,
)


class TestParseDurationToSeconds:
    """Tests for parse_duration_to_seconds function."""

    def test_full_duration_hours_minutes_seconds(self):
        """Test parsing duration with hours, minutes, and seconds."""
        result = parse_duration_to_seconds("PT1H2M3S")
        assert result == 3723  # 1*3600 + 2*60 + 3

    def test_duration_minutes_and_seconds(self):
        """Test parsing duration with only minutes and seconds."""
        result = parse_duration_to_seconds("PT5M30S")
        assert result == 330  # 5*60 + 30

    def test_duration_seconds_only(self):
        """Test parsing duration with only seconds."""
        result = parse_duration_to_seconds("PT45S")
        assert result == 45

    def test_duration_minutes_only(self):
        """Test parsing duration with only minutes."""
        result = parse_duration_to_seconds("PT10M")
        assert result == 600  # 10*60

    def test_duration_hours_only(self):
        """Test parsing duration with only hours."""
        result = parse_duration_to_seconds("PT2H")
        assert result == 7200  # 2*3600

    def test_duration_zero(self):
        """Test parsing zero duration."""
        result = parse_duration_to_seconds("PT0S")
        assert result == 0

    def test_invalid_duration_format(self):
        """Test parsing invalid duration format returns 0."""
        result = parse_duration_to_seconds("invalid")
        assert result == 0

    def test_malformed_duration(self):
        """Test parsing malformed duration returns 0."""
        result = parse_duration_to_seconds("P1D")
        assert result == 0


class TestFormatDuration:
    """Tests for format_duration function."""

    def test_format_hours_minutes_seconds(self):
        """Test formatting duration with hours, minutes, and seconds."""
        result = format_duration("PT1H2M3S")
        assert result == "1:02:03"

    def test_format_minutes_and_seconds(self):
        """Test formatting duration with only minutes and seconds."""
        result = format_duration("PT5M30S")
        assert result == "5:30"

    def test_format_seconds_only(self):
        """Test formatting duration with only seconds."""
        result = format_duration("PT45S")
        assert result == "0:45"

    def test_format_minutes_only(self):
        """Test formatting duration with only minutes."""
        result = format_duration("PT10M")
        assert result == "10:00"

    def test_format_hours_with_zero_padding(self):
        """Test that minutes and seconds are zero-padded in formatted output."""
        result = format_duration("PT1H0M5S")
        assert result == "1:00:05"

    def test_format_invalid_duration(self):
        """Test formatting invalid duration returns the original string."""
        result = format_duration("invalid")
        assert result == "invalid"


class TestExtractUrls:
    """Tests for extract_urls function."""

    def test_single_url(self):
        """Test extracting single URL from text."""
        text = "Check this out: https://example.com"
        result = extract_urls(text)
        assert result == ["https://example.com"]

    def test_multiple_urls(self):
        """Test extracting multiple URLs from text."""
        text = (
            "Visit https://example.com and http://test.org for more info"
        )
        result = extract_urls(text)
        assert result == ["https://example.com", "http://test.org"]

    def test_no_urls(self):
        """Test text with no URLs returns empty list."""
        text = "Just some regular text without links"
        result = extract_urls(text)
        assert result == []

    def test_url_trailing_punctuation_cleanup(self):
        """Test that trailing punctuation is removed from URLs."""
        text = "Check https://example.com. And https://test.org!"
        result = extract_urls(text)
        assert result == ["https://example.com", "https://test.org"]

    def test_url_trailing_question_mark(self):
        """Test URL with trailing question mark is cleaned."""
        text = "Is this real? https://example.com?"
        result = extract_urls(text)
        assert result == ["https://example.com"]

    def test_url_trailing_semicolon(self):
        """Test URL with trailing semicolon is cleaned."""
        text = "https://example.com; another sentence"
        result = extract_urls(text)
        assert result == ["https://example.com"]

    def test_url_with_parentheses(self):
        """Test URL with unbalanced closing parenthesis gets cleaned."""
        text = "(see https://en.wikipedia.org/wiki/Example_(disambiguation))"
        result = extract_urls(text)
        # The implementation removes trailing ) if unbalanced
        assert len(result) == 1
        assert result[0].startswith("https://en.wikipedia.org")

    def test_url_deduplication(self):
        """Test that duplicate URLs are deduplicated while preserving order."""
        text = (
            "Visit https://example.com and then https://example.com again"
        )
        result = extract_urls(text)
        assert result == ["https://example.com"]
        assert len(result) == 1

    def test_url_deduplication_multiple_different(self):
        """Test deduplication with multiple different URLs."""
        text = (
            "https://a.com, https://b.com, https://a.com, https://c.com"
        )
        result = extract_urls(text)
        assert result == ["https://a.com", "https://b.com", "https://c.com"]

    def test_url_with_query_parameters(self):
        """Test URL with query parameters is preserved correctly."""
        text = "https://example.com?param1=value1&param2=value2"
        result = extract_urls(text)
        assert result == ["https://example.com?param1=value1&param2=value2"]

    def test_url_with_fragment(self):
        """Test URL with fragment identifier."""
        text = "https://example.com/page#section"
        result = extract_urls(text)
        assert result == ["https://example.com/page#section"]

    def test_url_trailing_parenthesis_cleanup(self):
        """Test URL with trailing parenthesis when unbalanced."""
        text = "(see https://example.com)"
        result = extract_urls(text)
        assert result == ["https://example.com"]

    def test_mixed_protocols(self):
        """Test extraction with both http and https."""
        text = "Use http://insecure.com or https://secure.com"
        result = extract_urls(text)
        assert result == ["http://insecure.com", "https://secure.com"]


class TestFetchMetadata:
    """Tests for YouTubeMetadataService.fetch_metadata method."""

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_success(self, mock_build):
        """Test successful metadata fetch for valid video."""
        # Mock the YouTube API response
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {
            "items": [
                {
                    "snippet": {
                        "title": "Test Video",
                        "description": "Test description https://example.com",
                        "channelId": "channel123",
                        "channelTitle": "Test Channel",
                        "publishedAt": "2024-01-01T00:00:00Z",
                        "tags": ["test", "video"],
                        "categoryId": "24",
                        "thumbnails": {"default": {"url": "..."}},
                    },
                    "contentDetails": {"duration": "PT1H30M45S"},
                    "statistics": {
                        "viewCount": "1000000",
                        "likeCount": "50000",
                        "commentCount": "5000",
                    },
                }
            ]
        }

        service = YouTubeMetadataService(api_key="test_key")
        result = service.fetch_metadata("test_video_id")

        assert result.video_id == "test_video_id"
        assert result.title == "Test Video"
        assert result.description == "Test description https://example.com"
        assert result.description_urls == ["https://example.com"]
        assert result.channel_id == "channel123"
        assert result.channel_title == "Test Channel"
        assert result.published_at == "2024-01-01T00:00:00Z"
        assert result.duration == "PT1H30M45S"
        assert result.duration_seconds == 5445  # 1*3600 + 30*60 + 45
        assert result.duration_formatted == "1:30:45"
        assert result.view_count == 1000000
        assert result.like_count == 50000
        assert result.comment_count == 5000
        assert result.tags == ["test", "video"]
        assert result.category_id == "24"

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_missing_optional_fields(self, mock_build):
        """Test metadata fetch with missing optional fields."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {
            "items": [
                {
                    "snippet": {
                        "title": "Minimal Video",
                        "description": "",
                        "channelId": "channel456",
                        "channelTitle": "Channel",
                        "publishedAt": "2024-01-01T00:00:00Z",
                    },
                    "contentDetails": {"duration": "PT5M"},
                    "statistics": {"viewCount": "100"},
                }
            ]
        }

        service = YouTubeMetadataService(api_key="test_key")
        result = service.fetch_metadata("test_video_id")

        assert result.title == "Minimal Video"
        assert result.description == ""
        assert result.description_urls == []
        assert result.like_count is None
        assert result.comment_count is None
        assert result.tags == []
        assert result.category_id is None

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_video_not_found(self, mock_build):
        """Test fetch_metadata raises error for non-existent video."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {"items": []}

        service = YouTubeMetadataService(api_key="test_key")

        with pytest.raises(ValueError, match="Video not found"):
            service.fetch_metadata("nonexistent_id")

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_api_error(self, mock_build):
        """Test fetch_metadata propagates API errors."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.side_effect = Exception(
            "API quota exceeded"
        )

        service = YouTubeMetadataService(api_key="test_key")

        with pytest.raises(Exception, match="API quota exceeded"):
            service.fetch_metadata("test_video_id")

    def test_fetch_metadata_no_api_key(self):
        """Test fetch_metadata raises error when no API key configured."""
        # Create a service with explicit None to skip settings fallback
        service = YouTubeMetadataService.__new__(YouTubeMetadataService)
        service.api_key = None
        service._youtube = None

        with pytest.raises(ValueError, match="API key not configured"):
            service.fetch_metadata("test_video_id")

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_reuses_client(self, mock_build):
        """Test that YouTube client is lazy-loaded and reused."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {
            "items": [
                {
                    "snippet": {
                        "title": "Video 1",
                        "description": "",
                        "channelId": "ch1",
                        "channelTitle": "Ch1",
                        "publishedAt": "2024-01-01T00:00:00Z",
                    },
                    "contentDetails": {"duration": "PT1S"},
                    "statistics": {},
                }
            ]
        }

        service = YouTubeMetadataService(api_key="test_key")

        # Call fetch_metadata twice
        service.fetch_metadata("vid1")
        service.fetch_metadata("vid2")

        # build should be called only once (lazy-loaded)
        mock_build.assert_called_once()


class TestFetchChannelVideos:
    """Tests for YouTubeMetadataService.fetch_channel_videos method."""

    def test_channel_video_to_dict(self):
        """Test channel video serialization."""
        video = YouTubeChannelVideo(
            video_id="abc123def45",
            title="Title",
            url="https://www.youtube.com/watch?v=abc123def45",
            published_at="2024-01-01T00:00:00Z",
            duration="1:02",
            duration_seconds=62,
            view_count=10,
        )

        assert video.to_dict()["video_id"] == "abc123def45"
        assert video.to_dict()["duration_seconds"] == 62

    def test_resolve_channel_id_supports_at_handle(self):
        """Test resolving an @handle to channel ID."""
        youtube = MagicMock()
        youtube.search.return_value.list.return_value.execute.return_value = {
            "items": [{"snippet": {"channelId": "UC123"}}],
        }
        service = YouTubeMetadataService(api_key="test_key")
        service._youtube = youtube

        assert service.resolve_channel_id("@example") == "UC123"

    def test_resolve_channel_id_supports_handle_url(self):
        """Test resolving a handle URL to channel ID."""
        youtube = MagicMock()
        youtube.search.return_value.list.return_value.execute.return_value = {
            "items": [{"snippet": {"channelId": "UC123"}}],
        }
        service = YouTubeMetadataService(api_key="test_key")
        service._youtube = youtube

        assert service.resolve_channel_id("https://www.youtube.com/@example") == "UC123"

    def test_fetch_channel_videos_returns_uploads(self):
        """Test fetching upload playlist videos."""
        youtube = MagicMock()
        youtube.search.return_value.list.return_value.execute.return_value = {
            "items": [{"snippet": {"channelId": "UC123"}}],
        }
        youtube.channels.return_value.list.return_value.execute.return_value = {
            "items": [
                {"contentDetails": {"relatedPlaylists": {"uploads": "UU123"}}},
            ],
        }
        youtube.playlistItems.return_value.list.return_value.execute.return_value = {
            "items": [
                {
                    "contentDetails": {"videoId": "abc123def45"},
                    "snippet": {
                        "title": "From playlist",
                        "publishedAt": "2024-01-01T00:00:00Z",
                    },
                },
            ],
        }
        youtube.videos.return_value.list.return_value.execute.return_value = {
            "items": [
                {
                    "id": "abc123def45",
                    "snippet": {"title": "Video title"},
                    "contentDetails": {"duration": "PT1M2S"},
                    "statistics": {"viewCount": "10"},
                },
            ],
        }
        service = YouTubeMetadataService(api_key="test_key")
        service._youtube = youtube

        result = service.fetch_channel_videos("@example", limit=1)

        assert result[0].title == "Video title"
        assert result[0].duration == "1:02"
        assert result[0].duration_seconds == 62
        assert result[0].view_count == 10


class TestFetchMetadataSafe:
    """Tests for YouTubeMetadataService.fetch_metadata_safe method."""

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_safe_success(self, mock_build):
        """Test fetch_metadata_safe returns metadata on success."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {
            "items": [
                {
                    "snippet": {
                        "title": "Test",
                        "description": "",
                        "channelId": "ch",
                        "channelTitle": "Ch",
                        "publishedAt": "2024-01-01T00:00:00Z",
                    },
                    "contentDetails": {"duration": "PT1S"},
                    "statistics": {},
                }
            ]
        }

        service = YouTubeMetadataService(api_key="test_key")
        metadata, error = service.fetch_metadata_safe("test_id")

        assert metadata is not None
        assert error is None
        assert metadata.video_id == "test_id"
        assert metadata.title == "Test"

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_safe_not_found(self, mock_build):
        """Test fetch_metadata_safe returns None on video not found."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.return_value = {"items": []}

        service = YouTubeMetadataService(api_key="test_key")
        metadata, error = service.fetch_metadata_safe("nonexistent_id")

        assert metadata is None
        assert error is not None
        assert "Video not found" in error

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_safe_api_error(self, mock_build):
        """Test fetch_metadata_safe returns None on API error."""
        mock_youtube = MagicMock()
        mock_build.return_value = mock_youtube

        mock_request = MagicMock()
        mock_youtube.videos.return_value.list.return_value = mock_request
        mock_request.execute.side_effect = Exception(
            "API connection error"
        )

        service = YouTubeMetadataService(api_key="test_key")
        metadata, error = service.fetch_metadata_safe("test_id")

        assert metadata is None
        assert error is not None
        assert "API connection error" in error

    @patch("googleapiclient.discovery.build")
    def test_fetch_metadata_safe_no_api_key(self, mock_build):
        """Test fetch_metadata_safe handles missing API key."""
        # Create a service with explicit None to skip settings fallback
        service = YouTubeMetadataService.__new__(YouTubeMetadataService)
        service.api_key = None
        service._youtube = None

        metadata, error = service.fetch_metadata_safe("test_id")

        assert metadata is None
        assert error is not None
        assert "API key not configured" in error


class TestYouTubeMetadataDataclass:
    """Tests for YouTubeMetadata dataclass."""

    def test_to_dict_conversion(self):
        """Test that YouTubeMetadata converts to dict correctly."""
        metadata = YouTubeMetadata(
            video_id="test_id",
            title="Test Title",
            description="Test description",
            description_urls=["https://example.com"],
            channel_id="ch_id",
            channel_title="Channel",
            published_at="2024-01-01T00:00:00Z",
            duration="PT1H2M3S",
            duration_seconds=3723,
            duration_formatted="1:02:03",
            view_count=1000,
            like_count=100,
            comment_count=10,
            tags=["test"],
            category_id="24",
            thumbnails={"default": {"url": "..."}},
            fetched_at="2024-01-01T12:00:00Z",
        )

        result = metadata.to_dict()

        assert result["video_id"] == "test_id"
        assert result["title"] == "Test Title"
        assert result["description_urls"] == ["https://example.com"]
        assert result["duration_seconds"] == 3723
        assert result["duration_formatted"] == "1:02:03"
        assert result["view_count"] == 1000
        assert isinstance(result, dict)
