"""YouTube transcript fetching service."""

import re
from dataclasses import dataclass

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    YouTubeRequestFailed,
)
from youtube_transcript_api.proxies import WebshareProxyConfig

from menos.config import settings


@dataclass
class TranscriptSegment:
    """A segment of transcript with timing."""

    text: str
    start: float
    duration: float


@dataclass
class YouTubeTranscript:
    """Full transcript with metadata."""

    video_id: str
    segments: list[TranscriptSegment]
    language: str

    @property
    def full_text(self) -> str:
        """Get full transcript as plain text."""
        return " ".join(seg.text for seg in self.segments)

    @property
    def timestamped_text(self) -> str:
        """Get transcript with timestamps."""
        lines = []
        for seg in self.segments:
            minutes = int(seg.start // 60)
            seconds = int(seg.start % 60)
            lines.append(f"[{minutes:02d}:{seconds:02d}] {seg.text}")
        return "\n".join(lines)


class YouTubeService:
    """Service for fetching YouTube transcripts."""

    VIDEO_ID_PATTERNS = [
        r"(?:v=|/)([0-9A-Za-z_-]{11}).*",
        r"^([0-9A-Za-z_-]{11})$",
    ]

    def __init__(
        self,
        proxy_username: str,
        proxy_password: str,
    ):
        """Initialize YouTube service with Webshare proxy config."""
        self.proxy_config = WebshareProxyConfig(
            proxy_username=proxy_username,
            proxy_password=proxy_password,
        )

    def extract_video_id(self, url_or_id: str) -> str:
        """Extract video ID from URL or validate ID.

        Args:
            url_or_id: YouTube URL or video ID

        Returns:
            11-character video ID

        Raises:
            ValueError: If video ID cannot be extracted
        """
        for pattern in self.VIDEO_ID_PATTERNS:
            match = re.search(pattern, url_or_id)
            if match:
                return match.group(1)
        raise ValueError(f"Could not extract video ID from: {url_or_id}")

    def _map_transcript_error(self, video_id: str, exc: Exception) -> ValueError:
        """Convert a youtube_transcript_api exception to a descriptive ValueError."""
        if isinstance(exc, RequestBlocked):
            return ValueError(
                f"YouTube is blocking requests for video {video_id} despite using "
                f"Webshare proxy. Ensure you have purchased 'Residential' proxies "
                f"(not 'Proxy Server' or 'Static Residential'). "
                f"Check WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD in .env. "
                f"Original error: {exc}"
            )
        if isinstance(exc, YouTubeRequestFailed):
            return ValueError(
                f"YouTube request failed for video {video_id}. This may indicate a "
                f"proxy connection issue. Check WEBSHARE_PROXY_USERNAME and "
                f"WEBSHARE_PROXY_PASSWORD in .env. Original error: {exc}"
            )
        if isinstance(exc, VideoUnavailable):
            return ValueError(f"Video unavailable: {video_id}")
        if isinstance(exc, TranscriptsDisabled):
            return ValueError(f"Transcripts disabled for video: {video_id}")
        if isinstance(exc, NoTranscriptFound):
            return ValueError(f"No transcript found for video: {video_id}")
        return ValueError(f"Failed to fetch transcript: {exc}")

    def fetch_transcript(
        self,
        video_id: str,
        languages: list[str] | None = None,
    ) -> YouTubeTranscript:
        """Fetch transcript for a video."""
        if languages is None:
            languages = ["en"]
        try:
            api = YouTubeTranscriptApi(proxy_config=self.proxy_config)
            fetched = api.fetch(video_id, languages=tuple(languages))
            segments = [
                TranscriptSegment(text=entry.text, start=entry.start, duration=entry.duration)
                for entry in fetched
            ]
            return YouTubeTranscript(
                video_id=video_id,
                segments=segments,
                language=languages[0] if languages else "en",
            )
        except Exception as e:
            raise self._map_transcript_error(video_id, e) from e


def get_youtube_service() -> YouTubeService:
    """Get YouTube service instance."""
    return YouTubeService(
        proxy_username=settings.webshare_proxy_username,
        proxy_password=settings.webshare_proxy_password,
    )
