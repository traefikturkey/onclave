#!/usr/bin/env python
"""Export summaries from the vault to local markdown files with frontmatter."""

import argparse
import asyncio
import json
import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from menos.services.di import get_storage_context

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)


def slugify(text: str) -> str:
    """Convert text to URL-friendly slug."""
    # Convert to lowercase and replace spaces with hyphens
    slug = text.lower().replace(" ", "-")
    # Remove special characters, keep only alphanumeric and hyphens
    slug = re.sub(r"[^a-z0-9\-]", "", slug)
    # Remove consecutive hyphens
    slug = re.sub(r"-+", "-", slug)
    # Strip leading/trailing hyphens
    slug = slug.strip("-")
    return slug


def _serialize_frontmatter_value(key: str, value: object) -> str:
    """Serialize a single frontmatter key-value pair to YAML line."""
    if isinstance(value, str):
        return f'{key}: "{value}"'
    if isinstance(value, list):
        return f"{key}: {json.dumps(value)}"
    return f"{key}: {value}"


def create_frontmatter(
    title: str,
    video_id: str,
    channel: str | None,
    summary_model: str | None,
    tier: str | None,
    quality_score: int | None,
    tags: list[str] | None,
) -> str:
    """Create YAML frontmatter for markdown file."""
    exported_at = datetime.now(UTC).isoformat()

    frontmatter_dict: dict = {"title": title, "video_id": video_id}
    if channel:
        frontmatter_dict["channel"] = channel
    if summary_model:
        frontmatter_dict["summary_model"] = summary_model
    if tier:
        frontmatter_dict["tier"] = tier
    if quality_score is not None:
        frontmatter_dict["quality_score"] = quality_score
    if tags:
        frontmatter_dict["tags"] = tags
    frontmatter_dict["exported_at"] = exported_at

    serialized = [_serialize_frontmatter_value(k, v) for k, v in frontmatter_dict.items()]
    lines = ["---"] + serialized + ["---"]
    return "\n".join(lines)


async def _fetch_minio_metadata(
    minio, video_id: str, title: str, channel: str | None
) -> tuple[str, str | None, str | None]:
    """Fetch metadata.json from MinIO; returns (title, channel, summary_model)."""
    try:
        meta_bytes = await minio.download(f"youtube/{video_id}/metadata.json")
        minio_meta = json.loads(meta_bytes.decode("utf-8"))
        summary_model = minio_meta.get("summary_model")
        if minio_meta.get("title"):
            title = minio_meta["title"]
        if not channel:
            channel = minio_meta.get("channel_title")
        return title, channel, summary_model
    except Exception:
        return title, channel, None


async def _fetch_summary_text(minio, video_id: str) -> str:
    """Download summary markdown from MinIO; returns placeholder on missing."""
    try:
        summary_bytes = await minio.download(f"youtube/{video_id}/summary.md")
        return summary_bytes.decode("utf-8")
    except Exception as e:
        logger.warning(f"  No summary found: {e}")
        return "(No summary available)"


def _fetch_pipeline_result(surreal, item_id: str) -> tuple[str | None, int | None, list | None]:
    """Query SurrealDB for pipeline tier/quality/tags; returns (tier, quality_score, tags)."""
    try:
        raw = surreal.db.query(
            "SELECT processing_status, "
            "metadata.unified_result AS unified_result "
            "FROM content WHERE id = $id",
            {"id": item_id},
        )
        parsed = surreal._parse_query_result(raw)
        if parsed:
            rec = parsed[0]
            unified = rec.get("unified_result")
            if rec.get("processing_status") == "completed" and unified:
                return unified.get("tier"), unified.get("quality_score"), unified.get("tags")
    except Exception as e:
        logger.warning(f"  Could not fetch pipeline result: {e}")
    return None, None, None


async def _export_item(minio, surreal, item, output_path: Path, force: bool) -> None:
    """Export a single content item to a markdown file."""
    video_id = item.metadata.get("video_id", "") if item.metadata else ""
    if not video_id:
        logger.warning(f"Skipping item {item.id} - no video_id")
        return

    title = item.title or f"YouTube: {video_id}"
    channel = item.metadata.get("channel_title") if item.metadata else None

    title, channel, summary_model = await _fetch_minio_metadata(minio, video_id, title, channel)
    logger.info(f"Exporting {title}...")

    summary_text = await _fetch_summary_text(minio, video_id)
    tier, quality_score, tags = _fetch_pipeline_result(surreal, item.id)

    frontmatter = create_frontmatter(
        title=title,
        video_id=video_id,
        channel=channel,
        summary_model=summary_model,
        tier=tier,
        quality_score=quality_score,
        tags=tags,
    )

    filename = f"{slugify(title)}.md"
    filepath = output_path / filename

    if filepath.exists() and not force:
        logger.info(f"  {filename} already exists (use --force to overwrite)")
        return

    filepath.write_text(f"{frontmatter}\n\n{summary_text}\n", encoding="utf-8")
    logger.info(f"  Exported to {filename}")


async def export_summaries(
    output_dir: str = "data",
    force: bool = False,
    video_id: str | None = None,
) -> None:
    """Export summaries from vault to local markdown files.

    Args:
        output_dir: Directory to save markdown files
        force: Overwrite existing files
        video_id: Export only a specific video (optional)
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    async with get_storage_context() as (minio, surreal):
        limit = 1000
        items, _ = await surreal.list_content(content_type="youtube", limit=limit)

        if video_id:
            items = [
                item
                for item in items
                if item.metadata and item.metadata.get("video_id") == video_id
            ]

        if not items:
            logger.warning(f"No YouTube videos found{f' with ID {video_id}' if video_id else ''}")
            return

        logger.info(f"Exporting {len(items)} video summaries to {output_dir}\n")

        for item in items:
            await _export_item(minio, surreal, item, output_path, force)

        logger.info("\nDone!")

        logger.info("\nDone!")


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Export summaries from the vault to local markdown files"
    )
    parser.add_argument(
        "--output-dir",
        default="data",
        help="Output directory for markdown files (default: data/)",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing files",
    )
    parser.add_argument(
        "--video-id",
        help="Export only a specific video by ID",
    )

    args = parser.parse_args()

    await export_summaries(
        output_dir=args.output_dir,
        force=args.force,
        video_id=args.video_id,
    )


if __name__ == "__main__":
    asyncio.run(main())
