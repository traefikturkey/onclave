#!/usr/bin/env python
"""Refetch YouTube metadata for existing videos.

Fetches rich metadata from YouTube Data API and backfills both
MinIO metadata.json and SurrealDB content metadata fields.

Usage:
    PYTHONPATH=. uv run python scripts/refetch_metadata.py
    PYTHONPATH=. uv run python scripts/refetch_metadata.py --limit 200
    PYTHONPATH=. uv run python scripts/refetch_metadata.py --delay 10
    PYTHONPATH=. uv run python scripts/refetch_metadata.py --db-only
"""

import argparse
import asyncio
import io
import json
import logging
import time

from menos.services.di import get_storage_context
from menos.services.youtube_metadata import YouTubeMetadataService

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


async def _update_content(repository, item, title: str, tags: list, metadata: dict) -> None:
    """Update content title, tags, and metadata in PostgreSQL."""
    content_id = str(item.id)
    if content_id.startswith("content:"):
        content_id = content_id.split(":", 1)[1]
    await repository.update_content_fields(content_id, title=title, tags=tags, metadata=metadata)


async def _process_db_only(video_id: str, item, minio, surreal, counts: dict) -> None:
    """Update PostgreSQL from existing MinIO metadata.json (no YouTube API call)."""
    try:
        meta_bytes = await minio.download(f"youtube/{video_id}/metadata.json")
        meta_json = json.loads(meta_bytes.decode("utf-8"))
    except Exception as e:
        logger.error(f"  Failed to read metadata.json from MinIO: {e}")
        counts["fail"] += 1
        return

    logger.info(f"  Title: {meta_json.get('title', 'unknown')}")
    existing_meta = item.metadata or {}
    existing_meta.update(
        {
            "published_at": meta_json.get("published_at"),
            "fetched_at": meta_json.get("fetched_at"),
            "channel_id": meta_json.get("channel_id"),
            "channel_title": meta_json.get("channel_title"),
            "duration_seconds": meta_json.get("duration_seconds"),
            "view_count": meta_json.get("view_count"),
            "like_count": meta_json.get("like_count"),
            "description_urls": meta_json.get("description_urls", []),
        }
    )
    try:
        await _update_content(
            surreal,
            item,
            meta_json.get("title", f"YouTube: {video_id}"),
            meta_json.get("tags", []),
            existing_meta,
        )
        logger.info("  Updated PostgreSQL (title, tags, metadata)")
    except Exception as e:
        logger.error(f"  Failed to update PostgreSQL: {e}")
        counts["db_fail"] += 1
    counts["success"] += 1
    logger.info("")


async def _upload_yt_metadata(
    video_id: str, item, minio, surreal, yt, transcript_text: str, counts: dict
) -> None:
    """Write metadata.json to MinIO and backfill PostgreSQL."""
    metadata_dict = {
        "id": item.id,
        "video_id": video_id,
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
        "segment_count": (item.metadata.get("segment_count") if item.metadata else None),
        "transcript_length": len(transcript_text),
        "file_size": item.file_size,
        "author": item.author,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "fetched_at": yt.fetched_at,
    }
    await minio.upload(
        f"youtube/{video_id}/metadata.json",
        io.BytesIO(json.dumps(metadata_dict, indent=2).encode("utf-8")),
        "application/json",
    )
    logger.info("  Updated metadata.json in MinIO")

    existing_meta = item.metadata or {}
    existing_meta.update(
        {
            "published_at": yt.published_at,
            "fetched_at": yt.fetched_at,
            "channel_id": yt.channel_id,
            "channel_title": yt.channel_title,
            "duration_seconds": yt.duration_seconds,
            "view_count": yt.view_count,
            "like_count": yt.like_count,
            "description_urls": yt.description_urls,
        }
    )
    try:
        await _update_content(surreal, item, yt.title, yt.tags, existing_meta)
        logger.info("  Updated PostgreSQL (title, tags, metadata)")
    except Exception as e:
        logger.error(f"  Failed to update PostgreSQL: {e}")
        counts["db_fail"] += 1


async def _process_full(
    video_id: str, item, minio, surreal, metadata_service, counts: dict, delay: int
) -> None:
    """Fetch from YouTube API and update MinIO and PostgreSQL."""
    try:
        yt = metadata_service.fetch_metadata(video_id)
        logger.info(f"  Title: {yt.title}")
    except Exception as e:
        logger.error(f"  Failed to fetch metadata: {e}")
        counts["fail"] += 1
        return

    try:
        transcript_bytes = await minio.download(f"youtube/{video_id}/transcript.txt")
        transcript_text = transcript_bytes.decode("utf-8")
    except Exception as e:
        logger.error(f"  Failed to read transcript: {e}")
        counts["fail"] += 1
        return

    await _upload_yt_metadata(video_id, item, minio, surreal, yt, transcript_text, counts)
    counts["success"] += 1
    if delay > 0:
        logger.info(f"  Waiting {delay}s before next video...")
        time.sleep(delay)
    logger.info("")


async def refetch_all(limit: int = 1000, delay: int = 30, db_only: bool = False):
    """Refetch metadata for all YouTube videos."""
    async with get_storage_context() as (minio, surreal):
        metadata_service = YouTubeMetadataService()
        items, _ = await surreal.list_content(content_type="youtube", limit=limit)
        logger.info(f"Found {len(items)} YouTube videos to process\n")

        counts = {"success": 0, "skip": 0, "fail": 0, "db_fail": 0}

        for i, item in enumerate(items):
            video_id = item.metadata.get("video_id", "") if item.metadata else ""
            if not video_id:
                logger.warning(f"Skipping item {item.id} - no video_id")
                counts["skip"] += 1
                continue

            logger.info(f"[{i + 1}/{len(items)}] Processing {video_id}...")

            if db_only:
                await _process_db_only(video_id, item, minio, surreal, counts)
            else:
                item_delay = 0 if i == len(items) - 1 else delay
                await _process_full(
                    video_id, item, minio, surreal, metadata_service, counts, item_delay
                )

        logger.info("=" * 60)
        logger.info(
            f"Done! {counts['success']} updated, {counts['fail']} failed, "
            f"{counts['db_fail']} db errors, {counts['skip']} skipped"
        )


def main():
    parser = argparse.ArgumentParser(description="Refetch YouTube metadata")
    parser.add_argument(
        "--limit",
        type=int,
        default=1000,
        help="Maximum number of videos to process (default: 1000)",
    )
    parser.add_argument(
        "--delay",
        type=int,
        default=30,
        help="Seconds to wait between API calls (default: 30)",
    )
    parser.add_argument(
        "--db-only",
        action="store_true",
        help="Only update SurrealDB from existing MinIO metadata.json (no YouTube API calls)",
    )
    args = parser.parse_args()

    try:
        asyncio.run(refetch_all(limit=args.limit, delay=args.delay, db_only=args.db_only))
    except KeyboardInterrupt:
        logger.info("\nInterrupted.")


if __name__ == "__main__":
    main()
