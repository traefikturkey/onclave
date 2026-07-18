#!/usr/bin/env python
"""Batch process existing content through the unified pipeline.

Run with: PYTHONPATH=. uv run python scripts/classify_content.py
Use --dry-run to preview changes without applying them.
Use --force to reprocess already-processed content.
Use --content-type to filter by content type (e.g., youtube, markdown).
Use --limit to cap the total number of items to process.
"""

import argparse
import asyncio
import logging
from datetime import datetime

from minio import Minio
from surrealdb import Surreal

from menos.config import settings
from menos.services.di import get_unified_pipeline_provider
from menos.services.storage import MinIOStorage, SurrealDBRepository
from menos.services.unified_pipeline import UnifiedPipelineService

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def _create_pipeline_service(
    surreal_repo: SurrealDBRepository,
) -> UnifiedPipelineService | None:
    """Create unified pipeline service with all dependencies.

    Args:
        surreal_repo: SurrealDB repository

    Returns:
        UnifiedPipelineService or None if dependencies unavailable
    """
    if not settings.unified_pipeline_enabled:
        logger.info("Unified pipeline disabled in settings")
        return None

    try:
        provider = get_unified_pipeline_provider()
    except Exception as e:
        logger.error("Failed to create LLM provider: %s", e)
        return None

    return UnifiedPipelineService(
        llm_provider=provider,
        repo=surreal_repo,
        settings=settings,
    )


def _is_already_processed(surreal_repo, item) -> bool:
    """Return True if content has processing_status == 'completed'."""
    raw = surreal_repo.db.query(
        "SELECT processing_status FROM content WHERE id = $id",
        {"id": item.id},
    )
    parsed = surreal_repo._parse_query_result(raw)
    return bool(parsed and parsed[0].get("processing_status") == "completed")


async def _run_pipeline(item, surreal_repo, minio_storage, pipeline_service, stats: dict) -> None:
    """Download content, run pipeline, update status. Updates stats in-place."""
    content_id = item.id
    try:
        content_bytes = await minio_storage.download(item.file_path)
        content_text = content_bytes.decode("utf-8")
    except Exception as e:
        logger.error("  Failed to download content: %s", e)
        stats["failed"] += 1
        return

    await surreal_repo.update_content_processing_status(content_id, "processing")
    try:
        result = await pipeline_service.process(
            content_id=content_id,
            content_text=content_text,
            content_type=item.content_type,
            title=item.title or "Untitled",
        )
        if result:
            await surreal_repo.update_content_processing_result(
                content_id, result.model_dump(mode="json"), settings.app_version
            )
            logger.info(
                "  Processed: tier=%s score=%d tags=%s",
                result.tier,
                result.quality_score,
                result.tags,
            )
            stats["processed"] += 1
        else:
            await surreal_repo.update_content_processing_status(content_id, "failed")
            logger.warning("  Processing returned None")
            stats["failed"] += 1
    except Exception as e:
        logger.error("  Processing failed: %s", e)
        await surreal_repo.update_content_processing_status(content_id, "failed")
        stats["failed"] += 1


async def _process_item(
    item, surreal_repo, minio_storage, pipeline_service, args, stats: dict
) -> None:
    """Process a single content item, updating stats in-place."""
    content_id = item.id
    if not content_id:
        logger.warning("Skipping item with no ID: %s", item.title)
        stats["skipped"] += 1
        return

    if not args.force and _is_already_processed(surreal_repo, item):
        logger.info("  Skipping %s (already processed)", content_id)
        stats["skipped"] += 1
        return

    logger.info("Processing %s: %s (%s)", content_id, item.title, item.content_type)

    if args.dry_run:
        logger.info("  [DRY RUN] Would process content")
        stats["processed"] += 1
        return

    await _run_pipeline(item, surreal_repo, minio_storage, pipeline_service, stats)


async def _fetch_batch(surreal_repo, args, stats: dict, offset: int, batch_size: int):
    """Fetch one page of content, respecting the limit. Returns (items, total)."""
    if args.limit and stats["total"] >= args.limit:
        return [], 0
    return await surreal_repo.list_content(
        offset=offset,
        limit=batch_size,
        content_type=args.content_type,
    )


async def _run_batch_loop(surreal_repo, minio_storage, pipeline_service, args) -> dict:
    """Iterate over content in batches, process each item, return stats."""
    stats = {"total": 0, "processed": 0, "skipped": 0, "failed": 0}
    offset = 0
    batch_size = 20
    batch_num = 1

    while True:
        logger.info("Fetching batch %d (offset=%d)", batch_num, offset)
        items, total = await _fetch_batch(surreal_repo, args, stats, offset, batch_size)
        if not items:
            break

        for item in items:
            if args.limit and stats["total"] >= args.limit:
                break
            stats["total"] += 1
            await _process_item(item, surreal_repo, minio_storage, pipeline_service, args, stats)

        offset += batch_size
        batch_num += 1
        if offset >= total:
            break

    return stats


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Batch process content through the unified pipeline"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview changes without applying them"
    )
    parser.add_argument("--force", action="store_true", help="Reprocess already-processed content")
    parser.add_argument("--content-type", type=str, default=None, help="Filter by content type")
    parser.add_argument("--limit", type=int, default=0, help="Max items to process (0 = unlimited)")
    args = parser.parse_args()

    logger.info("Connecting to S3 storage at %s", settings.s3_endpoint_url)
    minio_client = Minio(
        settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=settings.s3_secure,
        region=settings.s3_region,
    )
    minio_storage = MinIOStorage(minio_client, settings.s3_bucket)

    logger.info("Connecting to SurrealDB at %s", settings.surrealdb_url)
    db = Surreal(settings.surrealdb_url)
    surreal_repo = SurrealDBRepository(
        db=db,
        namespace=settings.surrealdb_namespace,
        database=settings.surrealdb_database,
        username=settings.surrealdb_user,
        password=settings.surrealdb_password,
    )

    try:
        await surreal_repo.connect()
        logger.info("Connected to SurrealDB successfully")
    except Exception as e:
        logger.error("Failed to connect to SurrealDB: %s", e)
        return

    pipeline_service = _create_pipeline_service(surreal_repo)
    if not pipeline_service:
        logger.error("Pipeline service not available")
        return

    start_time = datetime.now()
    stats = await _run_batch_loop(surreal_repo, minio_storage, pipeline_service, args)
    duration = (datetime.now() - start_time).total_seconds()

    logger.info("=" * 60)
    logger.info("Processing complete!")
    logger.info("Duration: %.2f seconds", duration)
    logger.info("Total: %d", stats["total"])
    logger.info("Processed: %d", stats["processed"])
    logger.info("Skipped: %d", stats["skipped"])
    logger.info("Failed: %d", stats["failed"])
    logger.info("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
