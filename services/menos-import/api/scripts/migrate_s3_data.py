#!/usr/bin/env python
# /// script
# requires-python = ">=3.12"
# dependencies = ["minio"]
# ///
"""Migrate all objects from MinIO to Garage (S3-compatible).

Copies every object in the source bucket to the destination bucket, preserving
keys and content types.  Both endpoints use the standard S3 protocol via the
``minio`` Python SDK.

Usage (from api/ directory):
    # Dry run -- list objects without copying
    PYTHONPATH=. uv run python scripts/migrate_s3_data.py --dry-run

    # Migrate with defaults (MinIO on 9000 -> Garage on 3900)
    PYTHONPATH=. uv run python scripts/migrate_s3_data.py

    # Custom endpoints
    PYTHONPATH=. uv run python scripts/migrate_s3_data.py \
        --source-endpoint localhost:9000 \
        --dest-endpoint localhost:3900

    # Skip verification step
    PYTHONPATH=. uv run python scripts/migrate_s3_data.py --skip-verify
"""

import argparse
import io
import logging
import sys
import time

from minio import Minio
from minio.error import S3Error

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)


def build_client(
    endpoint: str,
    access_key: str,
    secret_key: str,
    secure: bool,
    region: str,
) -> Minio:
    """Create an S3 client."""
    return Minio(
        endpoint,
        access_key=access_key,
        secret_key=secret_key,
        secure=secure,
        region=region,
    )


def list_objects(client: Minio, bucket: str) -> list[dict]:
    """Return a list of {key, size, etag} dicts for every object in *bucket*."""
    objects = []
    for obj in client.list_objects(bucket, recursive=True):
        objects.append(
            {
                "key": obj.object_name,
                "size": obj.size,
                "etag": obj.etag,
            }
        )
    return objects


def _copy_object(
    source: Minio, dest: Minio, bucket: str, obj: dict, index: int, total: int, stats: dict
) -> None:
    """Copy a single object from source to dest, updating stats in-place."""
    key = obj["key"]
    size = obj["size"]
    try:
        try:
            dest_stat = dest.stat_object(bucket, key)
            if dest_stat.size == size:
                logger.info("  [%d/%d] Skipping (exists): %s (%d bytes)", index, total, key, size)
                stats["skipped"] += 1
                return
        except S3Error:
            pass

        response = source.get_object(bucket, key)
        data = response.read()
        response.close()
        response.release_conn()

        dest.put_object(
            bucket,
            key,
            io.BytesIO(data),
            length=len(data),
            content_type=response.headers.get("Content-Type", "application/octet-stream"),
        )
        stats["copied"] += 1
        stats["bytes"] += len(data)
        logger.info("  [%d/%d] Copied: %s (%d bytes)", index, total, key, len(data))
    except Exception as e:
        stats["failed"] += 1
        logger.error("  [%d/%d] Failed: %s -- %s", index, total, key, e)


def migrate(
    source: Minio,
    dest: Minio,
    bucket: str,
    dry_run: bool = False,
) -> dict:
    """Copy all objects from *source* to *dest*.

    Returns a stats dict with counts and byte totals.
    """
    stats = {"copied": 0, "skipped": 0, "failed": 0, "bytes": 0}
    source_objects = list_objects(source, bucket)
    total = len(source_objects)
    logger.info("Found %d objects in source bucket '%s'", total, bucket)

    if dry_run:
        for obj in source_objects:
            logger.info("  [DRY RUN] Would copy: %s (%d bytes)", obj["key"], obj["size"])
        stats["copied"] = total
        stats["bytes"] = sum(o["size"] for o in source_objects)
        return stats

    if not dest.bucket_exists(bucket):
        logger.info("Creating destination bucket '%s'", bucket)
        dest.make_bucket(bucket)

    for i, obj in enumerate(source_objects, 1):
        _copy_object(source, dest, bucket, obj, i, total, stats)

    return stats


def _check_missing_objects(src_keys: set, dst_keys: set) -> bool:
    """Log missing destination objects and return False if any are missing."""
    missing = src_keys - dst_keys
    if missing:
        logger.error("Missing %d objects in destination:", len(missing))
        for key in sorted(missing):
            logger.error("  %s", key)
        return False
    return True


def _check_size_mismatches(src_keys: set, src_by_key: dict, dst_by_key: dict) -> bool:
    """Log size mismatches and return False if any exist."""
    mismatches = [
        (key, src_by_key[key], dst_by_key[key])
        for key in src_keys
        if src_by_key[key] != dst_by_key[key]
    ]
    if mismatches:
        logger.error("Size mismatches for %d objects:", len(mismatches))
        for key, src_size, dst_size in mismatches:
            logger.error("  %s: source=%d dest=%d", key, src_size, dst_size)
        return False
    return True


def _index_objects(objects: list) -> tuple[set, dict]:
    """Return (key_set, key->size dict) for a list of object dicts."""
    keys = {o["key"] for o in objects}
    by_key = {o["key"]: o["size"] for o in objects}
    return keys, by_key


def verify(source: Minio, dest: Minio, bucket: str) -> bool:
    """Compare object counts and total sizes between source and dest.

    Returns True if they match.
    """
    logger.info("Verifying migration...")
    src_objects = list_objects(source, bucket)
    dst_objects = list_objects(dest, bucket)

    src_keys, src_by_key = _index_objects(src_objects)
    dst_keys, dst_by_key = _index_objects(dst_objects)

    if not _check_missing_objects(src_keys, dst_keys):
        return False
    if not _check_size_mismatches(src_keys, src_by_key, dst_by_key):
        return False

    src_total = sum(src_by_key.values())
    dst_total = sum(dst_by_key.values())
    logger.info(
        "Verification passed: %d objects, %d bytes in source, %d bytes in dest",
        len(src_objects),
        src_total,
        dst_total,
    )
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Migrate objects from MinIO to Garage (S3-compatible)",
    )
    parser.add_argument(
        "--source-endpoint",
        default="localhost:9000",
        help="Source S3 endpoint (default: localhost:9000)",
    )
    parser.add_argument(
        "--source-access-key",
        default="minioadmin",
        help="Source access key (default: minioadmin)",
    )
    parser.add_argument(
        "--source-secret-key",
        default="minioadmin",
        help="Source secret key (default: minioadmin)",
    )
    parser.add_argument(
        "--dest-endpoint",
        default="localhost:3900",
        help="Destination S3 endpoint (default: localhost:3900)",
    )
    parser.add_argument(
        "--dest-access-key",
        default="minioadmin",
        help="Destination access key",
    )
    parser.add_argument(
        "--dest-secret-key",
        default="changeme",
        help="Destination secret key",
    )
    parser.add_argument(
        "--dest-region",
        default="garage",
        help="Destination S3 region (default: garage)",
    )
    parser.add_argument(
        "--bucket",
        default="menos",
        help="Bucket name (default: menos)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List objects without copying",
    )
    parser.add_argument(
        "--skip-verify",
        action="store_true",
        help="Skip post-migration verification",
    )
    args = parser.parse_args()

    source = build_client(
        args.source_endpoint,
        args.source_access_key,
        args.source_secret_key,
        secure=False,
        region="us-east-1",
    )
    dest = build_client(
        args.dest_endpoint,
        args.dest_access_key,
        args.dest_secret_key,
        secure=False,
        region=args.dest_region,
    )

    logger.info(
        "Source: %s  Dest: %s  Bucket: %s",
        args.source_endpoint,
        args.dest_endpoint,
        args.bucket,
    )

    start = time.monotonic()
    stats = migrate(source, dest, args.bucket, dry_run=args.dry_run)
    elapsed = time.monotonic() - start

    logger.info("=" * 60)
    logger.info("Migration %s", "preview" if args.dry_run else "complete")
    logger.info(
        "Copied: %d  Skipped: %d  Failed: %d",
        stats["copied"],
        stats["skipped"],
        stats["failed"],
    )
    logger.info("Bytes transferred: %d", stats["bytes"])
    logger.info("Duration: %.1f seconds", elapsed)
    logger.info("=" * 60)

    if stats["failed"] > 0:
        logger.error("Some objects failed to copy -- see errors above")
        sys.exit(1)

    if not args.dry_run and not args.skip_verify:
        if not verify(source, dest, args.bucket):
            logger.error("Verification FAILED")
            sys.exit(1)

    logger.info("Done.")


if __name__ == "__main__":
    main()
