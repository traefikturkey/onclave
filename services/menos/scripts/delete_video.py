"""Delete a YouTube video from SurrealDB and MinIO.

Usage:
    PYTHONPATH=. uv run python scripts/delete_video.py VIDEO_ID
    PYTHONPATH=. uv run python scripts/delete_video.py VIDEO_ID --yes
"""

import argparse
import asyncio
import sys

from menos.services.di import get_storage_context


def _extract_content_id(item_id) -> str:
    """Normalize a SurrealDB record ID to a plain string ID."""
    if hasattr(item_id, "id"):
        return item_id.id
    if isinstance(item_id, str) and ":" in item_id:
        return item_id.split(":")[-1]
    return str(item_id)


def _confirm_deletion(video_id: str) -> bool:
    """Prompt user for deletion confirmation. Returns True if confirmed."""
    response = input(f"Delete video '{video_id}'? (y/N): ")
    return response.lower() in ["y", "yes"]


async def _delete_minio_files(minio, video_id: str, file_path: str) -> None:
    """Delete known MinIO files for a video."""
    if not file_path:
        return
    prefix = f"youtube/{video_id}/"
    for suffix in ["transcript.txt", "metadata.json", "summary.md", "timestamped.txt"]:
        try:
            await minio.delete(f"{prefix}{suffix}")
        except Exception:
            pass


async def delete_video(video_id: str, skip_confirm: bool = False) -> int:
    """Delete a video by YouTube video ID with confirmation."""
    async with get_storage_context() as (minio, repo):
        result = repo.db.query(
            "SELECT * FROM content WHERE content_type = 'youtube'"
            " AND metadata.video_id = $video_id LIMIT 1",
            {"video_id": video_id},
        )
        raw_items = repo._parse_query_result(result)

        if not raw_items:
            print(f"Video '{video_id}' not found in SurrealDB")
            return 1

        item = raw_items[0]
        content_id = _extract_content_id(item.get("id"))
        title = item.get("title", "Unknown")
        metadata = item.get("metadata", {})
        channel = metadata.get("channel_title", "Unknown") if metadata else "Unknown"

        print("\nVideo to delete:")
        print(f"  Title: {title}")
        print(f"  Video ID: {video_id}")
        print(f"  Content ID: {content_id}")
        print(f"  Channel: {channel}")
        print()

        if not skip_confirm and not _confirm_deletion(video_id):
            print("Deletion cancelled.")
            return 0

        print("Deleting chunks...")
        await repo.delete_chunks(content_id)
        print("Deleting entity edges...")
        await repo.delete_content_entity_edges(content_id)
        print("Deleting links...")
        await repo.delete_links_by_source(content_id)
        print("Deleting MinIO files...")
        await _delete_minio_files(minio, video_id, item.get("file_path", ""))
        print("Deleting content record...")
        await repo.delete_content(content_id)

        print(f"\nDeleted video '{video_id}' and all associated data.")
        return 0


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Delete a YouTube video from SurrealDB",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  PYTHONPATH=. uv run python scripts/delete_video.py abc123xyz
  PYTHONPATH=. uv run python scripts/delete_video.py abc123xyz --yes
        """,
    )
    parser.add_argument(
        "video_id",
        help="YouTube video ID to delete",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="Skip confirmation prompt",
    )

    args = parser.parse_args()

    try:
        sys.exit(asyncio.run(delete_video(args.video_id, args.yes)))
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(0)


if __name__ == "__main__":
    main()
