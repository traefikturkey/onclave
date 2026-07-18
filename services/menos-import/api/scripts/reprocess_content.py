#!/usr/bin/env python
"""Reprocess existing content to populate PKM data structures.

This script reprocesses existing content to:
- Parse frontmatter from markdown files and extract tags
- Extract wiki-links and markdown links from markdown content
- Populate the link table
- Extract tags from YouTube video metadata.json
- Update content tags in database
- Run unified pipeline processing (entity extraction, classification, etc.)

Run with: uv run python scripts/reprocess_content.py
Use --dry-run to preview changes without applying them.
Use --entities-only to only run unified pipeline processing (skip tags/links).
Use --skip-entities to skip unified pipeline processing (only run tags/links).
"""

import argparse
import asyncio
import json
import logging
from datetime import datetime

from minio import Minio
from surrealdb import Surreal

from menos.config import settings
from menos.models import LinkModel
from menos.services.frontmatter import FrontmatterParser
from menos.services.linking import LinkExtractor
from menos.services.storage import MinIOStorage, SurrealDBRepository

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


class ContentReprocessor:
    """Reprocesses existing content to populate new PKM data structures."""

    def __init__(
        self,
        surreal_repo: SurrealDBRepository,
        minio_storage: MinIOStorage,
        pipeline_orchestrator=None,
    ):
        """Initialize reprocessor with storage services.

        Args:
            surreal_repo: SurrealDB repository for metadata operations
            minio_storage: MinIO storage for file operations
            pipeline_orchestrator: Optional pipeline orchestrator
        """
        self.surreal_repo = surreal_repo
        self.minio_storage = minio_storage
        self.orchestrator = pipeline_orchestrator
        self.frontmatter_parser = FrontmatterParser()
        self.link_extractor = LinkExtractor()

        # Statistics
        self.stats = {
            "total": 0,
            "processed": 0,
            "skipped": 0,
            "errors": 0,
            "tags_updated": 0,
            "links_created": 0,
            "pipeline_jobs_submitted": 0,
        }

    def _log_summary(self, duration: float, entities_only: bool, skip_entities: bool) -> None:
        """Log the final processing summary."""
        logger.info("=" * 80)
        logger.info("Reprocessing complete!")
        logger.info(f"Duration: {duration:.2f} seconds")
        logger.info(f"Total items: {self.stats['total']}")
        logger.info(f"Processed: {self.stats['processed']}")
        logger.info(f"Skipped: {self.stats['skipped']}")
        logger.info(f"Errors: {self.stats['errors']}")
        if not entities_only:
            logger.info(f"Tags updated: {self.stats['tags_updated']}")
            logger.info(f"Links created: {self.stats['links_created']}")
        if not skip_entities:
            logger.info(f"Pipeline jobs submitted: {self.stats['pipeline_jobs_submitted']}")
        logger.info("=" * 80)

    async def _process_batch(
        self, items: list, dry_run: bool, entities_only: bool, skip_entities: bool
    ) -> None:
        """Process a single batch of content items."""
        self.stats["total"] += len(items)
        for item in items:
            if not item.id:
                logger.warning(f"Skipping item with no ID: {item.title}")
                self.stats["skipped"] += 1
                continue
            try:
                await self._reprocess_item(
                    item,
                    dry_run=dry_run,
                    entities_only=entities_only,
                    skip_entities=skip_entities,
                )
                self.stats["processed"] += 1
            except Exception as e:
                logger.error(f"Error processing content {item.id} ({item.title}): {e}")
                self.stats["errors"] += 1

    async def reprocess_all_content(
        self,
        dry_run: bool = False,
        entities_only: bool = False,
        skip_entities: bool = False,
    ) -> None:
        """Reprocess all content in the database.

        Args:
            dry_run: If True, preview changes without applying them
            entities_only: If True, only run entity extraction
            skip_entities: If True, skip entity extraction
        """
        start_time = datetime.now()
        logger.info("Starting content reprocessing...")
        if dry_run:
            logger.info("DRY RUN MODE - No changes will be applied")
        if entities_only:
            logger.info("ENTITIES ONLY MODE - Only running entity extraction")
        if skip_entities:
            logger.info("SKIP ENTITIES MODE - Skipping entity extraction")

        offset = 0
        limit = 20 if not skip_entities else 50
        batch_num = 1

        while True:
            logger.info(f"Fetching batch {batch_num} (offset={offset}, limit={limit})")
            items, total = await self.surreal_repo.list_content(offset=offset, limit=limit)
            if not items:
                break
            await self._process_batch(items, dry_run, entities_only, skip_entities)
            offset += limit
            batch_num += 1
            if offset >= total:
                break

        duration = (datetime.now() - start_time).total_seconds()
        self._log_summary(duration, entities_only, skip_entities)

    def _is_markdown(self, item) -> bool:
        """Return True if the item is a markdown document."""
        return item.mime_type == "text/markdown" or (
            item.file_path and item.file_path.endswith(".md")
        )

    async def _reprocess_pkm(self, item, dry_run: bool) -> None:
        """Run PKM reprocessing (tags + links) for a single item."""
        if item.content_type == "youtube":
            await self._reprocess_youtube(item, dry_run)
        elif self._is_markdown(item):
            await self._reprocess_markdown(item, dry_run)
        else:
            logger.info(f"  Skipping non-markdown content: {item.mime_type}")

    async def _reprocess_item(
        self,
        item,
        dry_run: bool,
        entities_only: bool = False,
        skip_entities: bool = False,
    ) -> None:
        """Reprocess a single content item."""
        logger.info(f"Processing {item.content_type}: {item.id} - {item.title}")

        if entities_only and getattr(item, "processing_status", None) == "completed":
            logger.info("  Pipeline processing already completed, skipping")
            self.stats["skipped"] += 1
            return

        if not entities_only:
            await self._reprocess_pkm(item, dry_run)

        if not skip_entities and self.orchestrator:
            await self._reprocess_pipeline(item, dry_run)

    async def _reprocess_pipeline(self, item, dry_run: bool) -> None:
        """Submit content to unified pipeline for processing.

        Args:
            item: ContentMetadata object
            dry_run: If True, preview changes without applying them
        """
        from menos.services.resource_key import generate_resource_key

        content_id = item.id
        content_type = item.content_type

        # Get content text
        content_text = await self._get_content_text(item)
        if not content_text:
            logger.info("  No content text available for pipeline processing")
            return

        logger.info(f"  Submitting to pipeline ({len(content_text)} chars)...")

        if dry_run:
            logger.info("  [DRY RUN] Would submit content to unified pipeline")
            return

        try:
            # Generate resource key
            resource_key = generate_resource_key(content_type, content_id)

            # Submit to pipeline orchestrator
            job = await self.orchestrator.submit(
                content_id=content_id,
                content_text=content_text,
                content_type=content_type,
                title=item.title or "Untitled",
                resource_key=resource_key,
            )

            if job:
                self.stats["pipeline_jobs_submitted"] += 1
                logger.info(f"  Submitted pipeline job {job.id}")
            else:
                logger.info("  Pipeline submission skipped (disabled or duplicate)")

        except Exception as e:
            logger.error(f"  Pipeline submission failed: {e}")
            raise

    async def _get_content_text(self, item) -> str | None:
        """Get the text content for entity extraction.

        Args:
            item: ContentMetadata object

        Returns:
            Content text or None
        """
        content_type = item.content_type

        if content_type == "youtube":
            # Get transcript from MinIO
            video_id = item.metadata.get("video_id") if item.metadata else None
            if not video_id:
                return None

            transcript_path = f"youtube/{video_id}/transcript.txt"
            try:
                transcript_bytes = await self.minio_storage.download(transcript_path)
                return transcript_bytes.decode("utf-8")
            except Exception:
                return None

        elif item.file_path and item.file_path.endswith(".md"):
            try:
                content_bytes = await self.minio_storage.download(item.file_path)
                content_text = content_bytes.decode("utf-8")
                # Strip frontmatter
                body, _ = self.frontmatter_parser.parse(content_text)
                return body
            except Exception:
                return None

        return None

    async def _apply_tag_update(self, item, merged_tags: list, dry_run: bool) -> None:
        """Persist merged tags to the content record unless dry_run."""
        if dry_run:
            logger.info(f"  [DRY RUN] Would update tags to: {merged_tags}")
        else:
            item.tags = merged_tags
            await self.surreal_repo.update_content(item.id, item)
            self.stats["tags_updated"] += 1

    def _compute_new_tags(self, item, tags_from_source: list) -> list:
        """Return tags from source that are not yet on item. Empty list if none."""
        existing = set(item.tags or [])
        return [t for t in tags_from_source if t not in existing]

    async def _reprocess_youtube(self, item, dry_run: bool) -> None:
        """Reprocess YouTube video to extract tags from metadata.json."""
        video_id = item.metadata.get("video_id") if item.metadata else None
        if not video_id:
            logger.warning(f"  No video_id in metadata for {item.id}")
            return

        try:
            metadata_bytes = await self.minio_storage.download(f"youtube/{video_id}/metadata.json")
            tags_from_metadata = json.loads(metadata_bytes.decode("utf-8")).get("tags", [])
        except Exception as e:
            logger.error(f"  Failed to fetch or parse metadata.json: {e}")
            raise

        if not tags_from_metadata:
            logger.info(f"  No tags in metadata.json for {video_id}")
            return

        new_tags = self._compute_new_tags(item, tags_from_metadata)
        if not new_tags:
            logger.info(f"  All tags already present in DB for {video_id}")
            return

        logger.info(
            f"  Found {len(tags_from_metadata)} tags in metadata.json, "
            f"adding {len(new_tags)} new tags"
        )
        await self._apply_tag_update(item, list(set(item.tags or [])) + new_tags, dry_run)

    async def _create_links(self, content_id: str, extracted_links: list) -> None:
        """Delete old links and create new resolved links for a content item."""
        await self.surreal_repo.delete_links_by_source(content_id)
        for link in extracted_links:
            target_id = None
            target_content = await self.surreal_repo.find_content_by_title(link.target)
            if target_content and target_content.id:
                target_id = target_content.id
                logger.info(
                    f"    Resolved link '{link.link_text}' -> '{link.target}' to {target_id}"
                )
            else:
                logger.info(f"    Unresolved link '{link.link_text}' -> '{link.target}'")
            await self.surreal_repo.create_link(
                LinkModel(
                    source=content_id,
                    target=target_id,
                    link_text=link.link_text,
                    link_type=link.link_type,
                )
            )
            self.stats["links_created"] += 1

    async def _reprocess_markdown_tags(self, item, content_text: str, dry_run: bool) -> bool:
        """Extract and apply frontmatter tags. Returns True if tags were updated."""
        _, frontmatter_metadata = self.frontmatter_parser.parse(content_text)
        tags_from_frontmatter = self.frontmatter_parser.extract_tags(
            frontmatter_metadata, explicit_tags=None
        )
        existing_tags = set(item.tags or [])
        new_tags = [t for t in tags_from_frontmatter if t not in existing_tags]
        if not new_tags:
            logger.info("  No new tags from frontmatter")
            return False
        logger.info(
            f"  Found {len(tags_from_frontmatter)} tags in frontmatter, "
            f"adding {len(new_tags)} new tags"
        )
        await self._apply_tag_update(item, list(existing_tags) + new_tags, dry_run)
        return True

    async def _reprocess_markdown(self, item, dry_run: bool) -> None:
        """Reprocess markdown content to extract frontmatter and links."""
        try:
            content_bytes = await self.minio_storage.download(item.file_path)
            content_text = content_bytes.decode("utf-8")
        except Exception as e:
            logger.error(f"  Failed to fetch or process markdown content: {e}")
            raise

        tags_updated = await self._reprocess_markdown_tags(item, content_text, dry_run)
        extracted_links = self.link_extractor.extract_links(content_text)

        if not extracted_links:
            logger.info("  No links found in content")
            if not tags_updated:
                self.stats["skipped"] += 1
            return

        logger.info(f"  Found {len(extracted_links)} links")
        if not dry_run:
            await self._create_links(item.id, extracted_links)
        else:
            logger.info(f"  [DRY RUN] Would create {len(extracted_links)} links:")
            for link in extracted_links[:5]:
                logger.info(f"    - {link.link_type}: '{link.link_text}' -> '{link.target}'")
            if len(extracted_links) > 5:
                logger.info(f"    ... and {len(extracted_links) - 5} more")


def _create_pipeline_orchestrator(surreal_repo: SurrealDBRepository):
    """Create pipeline orchestrator with all dependencies.

    Args:
        surreal_repo: SurrealDB repository

    Returns:
        PipelineOrchestrator or None if pipeline disabled
    """
    if not settings.unified_pipeline_enabled:
        logger.info("Unified pipeline disabled in settings")
        return None

    try:
        from menos.services.callbacks import CallbackService
        from menos.services.di import get_unified_pipeline_provider
        from menos.services.jobs import JobRepository
        from menos.services.pipeline_orchestrator import PipelineOrchestrator
        from menos.services.unified_pipeline import UnifiedPipelineService

        # Create provider
        provider = get_unified_pipeline_provider()

        # Create unified pipeline service
        pipeline_service = UnifiedPipelineService(
            llm_provider=provider,
            repo=surreal_repo,
            settings=settings,
        )

        # Create job repository
        job_repo = JobRepository(surreal_repo.db)

        # Create callback service
        callback_service = CallbackService(settings)

        # Create orchestrator
        return PipelineOrchestrator(
            pipeline_service,
            job_repo,
            surreal_repo,
            settings,
            callback_service,
        )

    except Exception as e:
        logger.warning(f"Pipeline orchestrator creation failed: {e}")
        return None


async def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Reprocess existing content to populate PKM data structures"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview changes without applying them",
    )
    parser.add_argument(
        "--entities-only",
        action="store_true",
        help="Only run unified pipeline processing (skip tags/links)",
    )
    parser.add_argument(
        "--skip-entities",
        action="store_true",
        help="Skip unified pipeline processing (only run tags/links)",
    )
    args = parser.parse_args()

    if args.entities_only and args.skip_entities:
        logger.error("Cannot use both --entities-only and --skip-entities")
        return

    # Initialize S3-compatible storage client
    logger.info(f"Connecting to S3 storage at {settings.s3_endpoint_url}")
    minio_client = Minio(
        settings.s3_endpoint_url,
        access_key=settings.s3_access_key,
        secret_key=settings.s3_secret_key,
        secure=settings.s3_secure,
        region=settings.s3_region,
    )
    minio_storage = MinIOStorage(minio_client, settings.s3_bucket)

    # Initialize SurrealDB repository
    logger.info(f"Connecting to SurrealDB at {settings.surrealdb_url}")
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
        logger.error(f"Failed to connect to SurrealDB: {e}")
        logger.error("Please ensure SurrealDB is running and accessible")
        return

    # Create pipeline orchestrator (if not skipping entities)
    orchestrator = None
    if not args.skip_entities:
        orchestrator = _create_pipeline_orchestrator(surreal_repo)
        if args.entities_only and not orchestrator:
            logger.error("Pipeline processing requested but orchestrator not available")
            return

    # Run reprocessing
    reprocessor = ContentReprocessor(
        surreal_repo,
        minio_storage,
        pipeline_orchestrator=orchestrator,
    )
    await reprocessor.reprocess_all_content(
        dry_run=args.dry_run,
        entities_only=args.entities_only,
        skip_entities=args.skip_entities,
    )


if __name__ == "__main__":
    asyncio.run(main())
