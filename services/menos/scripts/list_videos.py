"""List YouTube videos from SurrealDB.

Usage:
    PYTHONPATH=. uv run python scripts/list_videos.py
    PYTHONPATH=. uv run python scripts/list_videos.py --limit 20
    PYTHONPATH=. uv run python scripts/list_videos.py --limit 20 --offset 100
"""

import argparse
import asyncio
import sys

from menos.services.di import get_storage_context


async def list_videos(limit: int = 50, offset: int = 0) -> None:
    """List YouTube videos in SurrealDB."""
    async with get_storage_context() as (_minio, repo):
        # Get total count via raw query
        count_result = repo.db.query(
            "SELECT count() FROM content WHERE content_type = 'youtube' GROUP ALL"
        )
        raw_count = repo._parse_query_result(count_result)
        total = raw_count[0]["count"] if raw_count else 0

        print(f"\n{'=' * 80}")
        print("Videos in SurrealDB")
        print(f"{'=' * 80}\n")
        print(f"Total videos: {total}")
        print(f"Showing: {offset + 1} to {min(offset + limit, total)}\n")

        # Get videos
        videos, _ = await repo.list_content(content_type="youtube", limit=limit, offset=offset)

        if not videos:
            print("No videos found.\n")
            return

        for i, video in enumerate(videos, offset + 1):
            title = (video.title or "Unknown")[:60]
            video_id = video.metadata.get("video_id", "unknown") if video.metadata else "unknown"
            channel = (
                video.metadata.get("channel_title", "Unknown") if video.metadata else "Unknown"
            )

            print(f"[{i}] {title}")
            print(f"    ID: {video_id}")
            print(f"    Channel: {channel}")
            print(f"    URL: https://youtube.com/watch?v={video_id}")
            print()

        print(f"{'=' * 80}")
        print(f"Showing {len(videos)} of {total} videos")
        if offset + limit < total:
            print(f"Next page: --offset {offset + limit}")
        print(f"{'=' * 80}\n")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="List YouTube videos in SurrealDB")
    parser.add_argument(
        "--limit",
        "-l",
        type=int,
        default=50,
        help="Maximum number of videos to show (default: 50)",
    )
    parser.add_argument(
        "--offset",
        "-o",
        type=int,
        default=0,
        help="Number of videos to skip (default: 0)",
    )

    args = parser.parse_args()

    try:
        asyncio.run(list_videos(args.limit, args.offset))
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(0)


if __name__ == "__main__":
    main()
