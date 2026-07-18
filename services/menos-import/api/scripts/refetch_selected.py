#!/usr/bin/env python
"""Refetch metadata for selected videos from youtube-videos.txt."""

import asyncio
import io
import json
import logging
import re
from pathlib import Path

from menos.services.di import get_storage_context
from menos.services.youtube_metadata import YouTubeMetadataService

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def extract_video_ids(filepath: Path) -> list[str]:
    """Extract YouTube video IDs from the videos file."""
    content = filepath.read_text()
    urls = re.findall(r"youtube\.com/watch\?v=([A-Za-z0-9_-]+)", content)
    return urls


async def _update_video_metadata(vid: str, item, minio, surreal, metadata_service) -> None:
    """Fetch YouTube metadata and update MinIO + SurrealDB for one video."""
    logger.info(f"Processing {vid}...")

    try:
        yt = metadata_service.fetch_metadata(vid)
        logger.info(f"  Title: {yt.title}")
    except Exception as e:
        logger.error(f"  Failed to fetch metadata: {e}")
        return

    try:
        tb = await minio.download(f"youtube/{vid}/transcript.txt")
        transcript_text = tb.decode("utf-8")
    except Exception as e:
        logger.error(f"  Failed to read transcript: {e}")
        return

    md = {
        "id": item.id,
        "video_id": vid,
        "title": yt.title,
        "description": yt.description,
        "description_urls": yt.description_urls,
        "channel_id": yt.channel_id,
        "channel_title": yt.channel_title,
        "published_at": yt.published_at,
        "duration": yt.duration_formatted,
        "duration_seconds": yt.duration_seconds,
        "view_count": yt.view_count,
        "like_count": yt.like_count,
        "tags": yt.tags,
        "thumbnails": yt.thumbnails,
        "language": item.metadata.get("language", "en") if item.metadata else "en",
        "transcript_length": len(transcript_text),
        "file_size": item.file_size,
        "author": item.author,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "fetched_at": yt.fetched_at,
    }
    await minio.upload(
        f"youtube/{vid}/metadata.json",
        io.BytesIO(json.dumps(md, indent=2).encode("utf-8")),
        "application/json",
    )
    logger.info("  Updated metadata.json")

    try:
        surreal.db.query(
            "UPDATE content SET title = $title WHERE id = $id",
            {"title": yt.title, "id": item.id},
        )
        logger.info("  Updated SurrealDB title")
    except Exception as e:
        logger.error(f"  Failed to update SurrealDB: {e}")

    logger.info("")


async def refetch_selected():
    """Refetch metadata for videos in youtube-videos.txt."""
    videos_file = Path(__file__).parent.parent.parent / "data" / "youtube-videos.txt"
    target_ids = extract_video_ids(videos_file)
    logger.info(f"Found {len(target_ids)} video IDs to process\n")

    async with get_storage_context() as (minio, surreal):
        metadata_service = YouTubeMetadataService()

        items, _ = await surreal.list_content(content_type="youtube", limit=1000)
        video_map = {
            item.metadata.get("video_id", ""): item
            for item in items
            if item.metadata and item.metadata.get("video_id", "") in target_ids
        }

        for vid in target_ids:
            item = video_map.get(vid)
            if not item:
                logger.warning(f"Video {vid} not found in DB, skipping")
                continue
            await _update_video_metadata(vid, item, minio, surreal, metadata_service)

        logger.info("Done!")


if __name__ == "__main__":
    asyncio.run(refetch_selected())
