"""Classify URLs in YouTube video descriptions using heuristic filtering.

Processes YouTube video descriptions to extract and classify URLs as
content-related or marketing/spam using rule-based heuristics.

Usage:
    PYTHONPATH=. uv run python scripts/filter_description_urls.py VIDEO_ID
    PYTHONPATH=. uv run python scripts/filter_description_urls.py --all
    PYTHONPATH=. uv run python scripts/filter_description_urls.py --all --dry-run
"""

import argparse
import asyncio
import sys

from menos.services.di import get_storage_context
from menos.services.url_filter import apply_heuristic_filter
from menos.services.youtube_metadata import extract_urls


def _extract_content_id(item_id) -> str:
    """Normalize a SurrealDB record ID to a plain string."""
    if hasattr(item_id, "id"):
        return item_id.id
    if isinstance(item_id, str) and ":" in item_id:
        return item_id.split(":")[-1]
    return str(item_id)


def _print_filter_results(description_urls: list, blocked: list, remaining: list) -> None:
    """Print URL filtering results to stdout."""
    print("\nURL Filtering Results:")
    print(f"  Total URLs found: {len(description_urls)}")
    print(f"  Blocked (heuristic): {len(blocked)}")
    print(f"  Content URLs: {len(remaining)}")
    if remaining:
        print("\n  Content URLs:")
        for url in remaining:
            print(f"    [+] {url}")
    if blocked:
        print("\n  Blocked URLs:")
        for url, reason in blocked:
            print(f"    [-] {url} ({reason})")


def _save_filter_results(
    repo, content_id: str, description_urls: list, blocked: list, remaining: list
) -> None:
    """Persist URL filter results to the content metadata."""
    url_filter_results = {
        "all_urls": description_urls,
        "content_urls": remaining,
        "blocked_urls": [url for url, _ in blocked],
        "blocked_reasons": {url: reason for url, reason in blocked},
        "filter_version": "v1_heuristic",
    }
    repo.db.query(
        "UPDATE content SET metadata.url_filter_results = $data,"
        " updated_at = time::now() WHERE id = $id",
        {"data": url_filter_results, "id": f"content:{content_id}"},
    )


async def process_single_video(
    video_id: str,
    repo,
    dry_run: bool = False,
) -> dict:
    """Process URLs for a single video.

    Returns:
        Dict with processing results.
    """
    result = repo.db.query(
        "SELECT * FROM content WHERE content_type = 'youtube'"
        " AND metadata.video_id = $video_id LIMIT 1",
        {"video_id": video_id},
    )
    raw_items = repo._parse_query_result(result)

    if not raw_items:
        return {"success": False, "message": f"Video not found: {video_id}"}

    item = raw_items[0]
    title = item.get("title", "Unknown")
    metadata = item.get("metadata", {}) or {}
    channel = metadata.get("channel_title", "Unknown")
    description = metadata.get("description", "")
    content_id = _extract_content_id(item.get("id"))

    description_urls = metadata.get("description_urls", [])
    if not description_urls and description:
        description_urls = extract_urls(description)

    print(f"\nProcessing video: {video_id}")
    print(f"Title: {title}")
    print(f"Channel: {channel}")

    if not description_urls:
        print("  No URLs found in description.")
        return {"success": True, "video_id": video_id, "total_urls": 0}

    filter_result = apply_heuristic_filter(description_urls)
    blocked = filter_result["blocked"]
    remaining = filter_result["remaining"]
    _print_filter_results(description_urls, blocked, remaining)

    if not dry_run:
        _save_filter_results(repo, content_id, description_urls, blocked, remaining)
        print("\n  Content metadata updated.")
    else:
        print("\n  [DRY RUN] Content metadata NOT updated.")

    return {
        "success": True,
        "video_id": video_id,
        "total_urls": len(description_urls),
        "content_urls": len(remaining),
        "blocked_urls": len(blocked),
    }


def _update_batch_stats(total_stats: dict, result: dict, video_id: str) -> None:
    """Update batch stats in-place from a single video result."""
    if result["success"]:
        total_stats["processed"] += 1
        total_stats["total_urls"] += result.get("total_urls", 0)
        total_stats["content_urls"] += result.get("content_urls", 0)
        total_stats["blocked_urls"] += result.get("blocked_urls", 0)
    else:
        total_stats["skipped"] += 1
        print(f"  [SKIP] {result['message']}")


async def process_all_videos(repo, dry_run: bool = False) -> dict:
    """Process URLs for all YouTube videos."""
    offset = 0
    batch_size = 50
    total_stats = {
        "processed": 0,
        "skipped": 0,
        "errors": 0,
        "total_urls": 0,
        "content_urls": 0,
        "blocked_urls": 0,
    }

    while True:
        items, count = await repo.list_content(
            content_type="youtube", limit=batch_size, offset=offset
        )
        if not items:
            break

        for item in items:
            video_id = item.metadata.get("video_id", "") if item.metadata else ""
            if not video_id:
                total_stats["skipped"] += 1
                continue
            try:
                result = await process_single_video(video_id, repo, dry_run)
                _update_batch_stats(total_stats, result, video_id)
            except Exception as e:
                total_stats["errors"] += 1
                print(f"  [ERROR] {video_id}: {e}")
            print("-" * 70)

        offset += batch_size
        if count < batch_size:
            break

    print(f"\n{'=' * 70}")
    print("Batch Processing Summary")
    print(f"{'=' * 70}")
    print(f"Processed: {total_stats['processed']}")
    print(f"Skipped: {total_stats['skipped']}")
    print(f"Errors: {total_stats['errors']}")
    print("\nURL Statistics:")
    print(f"  Total URLs found: {total_stats['total_urls']}")
    print(f"  Content URLs: {total_stats['content_urls']}")
    print(f"  Blocked (heuristic): {total_stats['blocked_urls']}")
    print(f"{'=' * 70}\n")

    return total_stats


async def main_async(args: argparse.Namespace) -> None:
    """Async main."""
    async with get_storage_context() as (_minio, repo):
        if args.all:
            print(f"{'=' * 70}")
            print("Batch URL Filtering (Heuristic)")
            print(f"Dry run: {args.dry_run}")
            print(f"{'=' * 70}\n")
            stats = await process_all_videos(repo, args.dry_run)
            if stats["errors"] > 0:
                sys.exit(1)
        else:
            result = await process_single_video(args.video_id, repo, args.dry_run)
            if not result["success"]:
                print(f"\n[ERROR] {result['message']}")
                sys.exit(1)


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Classify URLs in YouTube video descriptions")
    parser.add_argument(
        "video_id",
        nargs="?",
        help="YouTube video ID to process (omit for --all)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Process all YouTube videos",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show results without updating metadata",
    )

    args = parser.parse_args()

    if not args.video_id and not args.all:
        parser.print_help()
        print("\nError: Provide VIDEO_ID or --all")
        sys.exit(1)

    if args.video_id and args.all:
        print("Error: Cannot specify both VIDEO_ID and --all")
        sys.exit(1)

    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(0)


if __name__ == "__main__":
    main()
