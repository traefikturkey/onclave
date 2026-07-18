"""Unified URL ingestion endpoint."""

import hashlib
import io
import json
import logging
from typing import Annotated, Literal
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AnyHttpUrl, BaseModel, field_validator
from surrealdb import RecordID

from menos.auth.dependencies import AuthenticatedKeyId
from menos.models import ContentMetadata
from menos.services.di import (
    get_docling_client,
    get_minio_storage,
    get_pipeline_orchestrator,
    get_surreal_repo,
)
from menos.services.docling import DoclingClient
from menos.services.pipeline_orchestrator import PipelineOrchestrator
from menos.services.resource_key import generate_resource_key
from menos.services.storage import MinIOStorage, SurrealDBRepository
from menos.services.url_detector import URLDetector
from menos.services.youtube import YouTubeService, get_youtube_service
from menos.services.youtube_metadata import (
    YouTubeMetadata,
    YouTubeMetadataService,
    get_youtube_metadata_service,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])

EXPLICIT_TRACKING_PARAMS = {
    "gbraid",
    "wbraid",
    "mc_cid",
    "mc_eid",
    "hsenc",
    "_hsmi",
    "hsctatracking",
}


class IngestRequest(BaseModel):
    """Unified ingest request."""

    url: AnyHttpUrl
    transcript_text: str | None = None
    transcript_format: Literal["plain"] = "plain"
    metadata: dict | None = None

    @field_validator("transcript_text")
    @classmethod
    def validate_transcript_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value.strip():
            raise ValueError("transcript_text must not be empty")
        if len(value.encode("utf-8")) > 5 * 1024 * 1024:
            raise HTTPException(status_code=413, detail="transcript_text exceeds 5 MB")
        return value


class IngestResponse(BaseModel):
    """Unified ingest response."""

    content_id: str
    content_type: str
    title: str
    job_id: str | None = None


@router.post("", response_model=IngestResponse)
async def ingest_url(
    body: IngestRequest,
    key_id: AuthenticatedKeyId,
    tags: Annotated[list[str] | None, Query()] = None,
    docling_client: DoclingClient = Depends(get_docling_client),
    youtube_service: YouTubeService = Depends(get_youtube_service),
    metadata_service: YouTubeMetadataService = Depends(get_youtube_metadata_service),
    minio_storage: MinIOStorage = Depends(get_minio_storage),
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
    orchestrator: PipelineOrchestrator = Depends(get_pipeline_orchestrator),
):
    """Ingest YouTube or web URLs through a single endpoint."""
    raw_url = str(body.url)
    detector = URLDetector()
    detected = detector.classify_url(raw_url)

    if detected.url_type == "youtube":
        video_id = detected.extracted_id or youtube_service.extract_video_id(raw_url)
        resource_key = generate_resource_key("youtube", video_id)
        return await _ingest_youtube(
            video_id=video_id,
            key_id=key_id,
            resource_key=resource_key,
            svc=(youtube_service, metadata_service, minio_storage, surreal_repo),
            orchestrator=orchestrator,
            tags=tags,
            transcript_text=body.transcript_text,
            client_metadata=body.metadata,
        )

    return await _ingest_web(
        url=raw_url,
        key_id=key_id,
        docling_client=docling_client,
        minio_storage=minio_storage,
        surreal_repo=surreal_repo,
        orchestrator=orchestrator,
        tags=tags,
    )


def _has_incomplete_metadata(existing: ContentMetadata, video_id: str) -> bool:
    """Check if an existing YouTube record is missing YouTube API metadata.

    Returns True when the record was ingested but the metadata fetch failed,
    leaving a placeholder title and no channel info.
    """
    if not existing or not existing.id:
        return False

    meta = existing.metadata or {}

    # Placeholder title means metadata fetch failed during original ingest
    if existing.title and existing.title == f"YouTube: {video_id}":
        return True

    # No title at all
    if not existing.title:
        return True

    # Has a title but missing channel info (metadata fetch partially failed)
    if not meta.get("channel_title"):
        return True

    return False


def _yt_metadata_fields(yt_metadata: YouTubeMetadata | None) -> dict:
    """Extract YouTube API metadata fields (all None/empty when metadata unavailable)."""
    if yt_metadata is None:
        return {
            "description": None,
            "description_urls": [],
            "channel_id": None,
            "channel_title": None,
            "published_at": None,
            "duration": None,
            "duration_seconds": None,
            "view_count": None,
            "like_count": None,
            "tags": [],
            "thumbnails": {},
            "fetched_at": None,
        }
    return {
        "description": yt_metadata.description,
        "description_urls": yt_metadata.description_urls,
        "channel_id": yt_metadata.channel_id,
        "channel_title": yt_metadata.channel_title,
        "published_at": yt_metadata.published_at,
        "duration": yt_metadata.duration_formatted,
        "duration_seconds": yt_metadata.duration_seconds,
        "view_count": yt_metadata.view_count,
        "like_count": yt_metadata.like_count,
        "tags": yt_metadata.tags,
        "thumbnails": yt_metadata.thumbnails,
        "fetched_at": yt_metadata.fetched_at,
    }


def _build_minio_metadata(
    content_id: str,
    video_id: str,
    title: str,
    yt_metadata: YouTubeMetadata | None,
    transcript_info: tuple[str, int, int],
    file_info: tuple[int, str | None, str | None],
) -> dict:
    """Build metadata.json dictionary for MinIO storage.

    Args:
        transcript_info: (language, segment_count, transcript_length)
        file_info: (file_size, author, created_at)
    """
    language, segment_count, transcript_length = transcript_info
    file_size, author, created_at = file_info
    return {
        "id": content_id,
        "video_id": video_id,
        "title": title,
        **_yt_metadata_fields(yt_metadata),
        "language": language,
        "segment_count": segment_count,
        "transcript_length": transcript_length,
        "file_size": file_size,
        "author": author,
        "created_at": created_at,
    }


async def _resolve_existing_youtube(
    video_id: str,
    resource_key: str,
    surreal_repo: SurrealDBRepository,
) -> ContentMetadata | None:
    """Look up an existing YouTube record by resource_key, falling back to video_id."""
    existing = await surreal_repo.find_content_by_resource_key(resource_key)
    if existing is None:
        existing = await surreal_repo.find_content_by_video_id(video_id)
        if existing:
            surreal_repo.db.query(
                "UPDATE content SET metadata.resource_key = $resource_key WHERE id = $id",
                {
                    "resource_key": resource_key,
                    "id": RecordID("content", str(existing.id).split(":")[-1]),
                },
            )
    return existing


async def _ingest_youtube(
    video_id: str,
    key_id: str,
    resource_key: str,
    svc: tuple[YouTubeService, YouTubeMetadataService, MinIOStorage, SurrealDBRepository],
    orchestrator: PipelineOrchestrator,
    tags: list[str] | None = None,
    transcript_text: str | None = None,
    client_metadata: dict | None = None,
) -> IngestResponse:
    youtube_service, metadata_service, minio_storage, surreal_repo = svc
    existing = await _resolve_existing_youtube(video_id, resource_key, surreal_repo)

    if existing and existing.id and not _has_incomplete_metadata(existing, video_id):
        return IngestResponse(
            content_id=existing.id,
            content_type=existing.content_type,
            title=existing.title or f"YouTube: {video_id}",
            job_id=None,
        )

    if existing and existing.id:
        return await _backfill_youtube_metadata(
            video_id=video_id,
            existing=existing,
            metadata_service=metadata_service,
            minio_storage=minio_storage,
            surreal_repo=surreal_repo,
        )

    return await _ingest_new_youtube(
        video_id=video_id,
        key_id=key_id,
        resource_key=resource_key,
        svc=(youtube_service, metadata_service, minio_storage, surreal_repo),
        orchestrator=orchestrator,
        tags=tags,
        transcript_text=transcript_text,
        client_metadata=client_metadata,
    )


def _build_updated_metadata(existing_meta: dict, yt_metadata: YouTubeMetadata) -> dict:
    """Merge fetched YouTube metadata fields into existing content metadata."""
    return {
        **existing_meta,
        "published_at": yt_metadata.published_at,
        "fetched_at": yt_metadata.fetched_at,
        "channel_id": yt_metadata.channel_id,
        "channel_title": yt_metadata.channel_title,
        "duration_seconds": yt_metadata.duration_seconds,
        "view_count": yt_metadata.view_count,
        "like_count": yt_metadata.like_count,
        "description_urls": yt_metadata.description_urls,
    }


def _existing_ingest_response(existing: ContentMetadata, video_id: str) -> IngestResponse:
    return IngestResponse(
        content_id=existing.id,
        content_type=existing.content_type,
        title=existing.title or f"YouTube: {video_id}",
        job_id=None,
    )


async def _backfill_youtube_metadata(
    video_id: str,
    existing: ContentMetadata,
    metadata_service: YouTubeMetadataService,
    minio_storage: MinIOStorage,
    surreal_repo: SurrealDBRepository,
) -> IngestResponse:
    """Backfill YouTube API metadata for an existing record with incomplete data."""
    logger.info("Backfilling metadata for existing record %s", existing.id)
    existing_meta = existing.metadata or {}

    try:
        yt_metadata = metadata_service.fetch_metadata(video_id)
        logger.info("Fetched metadata for video %s: %s", video_id, yt_metadata.title)
    except Exception as e:
        logger.warning("Failed to fetch YouTube metadata for %s: %s", video_id, e)
        return _existing_ingest_response(existing, video_id)

    title = yt_metadata.title
    updated_metadata = _build_updated_metadata(existing_meta, yt_metadata)

    # Note: WHERE id = $id requires RecordID object, not plain string (see gotchas.md)
    try:
        surreal_repo.db.query(
            "UPDATE content SET title = $title, tags = $tags, metadata = $metadata WHERE id = $id",
            {
                "title": title,
                "tags": yt_metadata.tags,
                "metadata": updated_metadata,
                "id": RecordID("content", existing.id),
            },
        )
        logger.info("Updated metadata for video %s in database", video_id)
    except Exception as e:
        logger.error("Failed to update SurrealDB for %s: %s", video_id, e)
        return _existing_ingest_response(existing, video_id)

    transcript_length = await _read_transcript_length(minio_storage, existing.file_path)
    created_at_str = existing.created_at.isoformat() if existing.created_at else None
    language = existing_meta.get("language", "en")
    segment_count = existing_meta.get("segment_count", 0)
    metadata_dict = _build_minio_metadata(
        existing.id,
        video_id,
        title,
        yt_metadata,
        (language, segment_count, transcript_length),
        (existing.file_size, existing.author, created_at_str),
    )
    try:
        await minio_storage.upload(
            f"youtube/{video_id}/metadata.json",
            io.BytesIO(json.dumps(metadata_dict, indent=2).encode("utf-8")),
            "application/json",
        )
    except Exception as e:
        logger.warning("Failed to update metadata.json for %s: %s", video_id, e)

    return IngestResponse(content_id=existing.id, content_type="youtube", title=title, job_id=None)


async def _read_transcript_length(minio_storage: MinIOStorage, file_path: str) -> int:
    """Download transcript and return its character length; returns 0 on error."""
    try:
        transcript_bytes = await minio_storage.download(file_path)
        return len(transcript_bytes.decode("utf-8"))
    except Exception as e:
        logger.warning("Failed to read transcript for metadata.json: %s", e)
        return 0


def _merge_client_metadata(base: dict, client_metadata: dict | None) -> dict:
    """Merge client-supplied metadata using menos field names."""
    if not client_metadata:
        return base
    return {**base, **client_metadata}


def _build_yt_content_metadata(
    video_id: str,
    resource_key: str,
    transcript_language: str,
    segment_count: int,
    yt_metadata: YouTubeMetadata | None,
    client_metadata: dict | None = None,
) -> dict:
    """Build the SurrealDB content metadata dict for a new YouTube ingest."""
    base = {
        "video_id": video_id,
        "language": transcript_language,
        "segment_count": segment_count,
        "resource_key": resource_key,
        **{
            k: (getattr(yt_metadata, a) if yt_metadata else d)
            for k, a, d in [
                ("published_at", "published_at", None),
                ("fetched_at", "fetched_at", None),
                ("channel_id", "channel_id", None),
                ("channel_title", "channel_title", None),
                ("duration_seconds", "duration_seconds", None),
                ("view_count", "view_count", None),
                ("like_count", "like_count", None),
                ("description_urls", "description_urls", []),
            ]
        },
    }
    return _merge_client_metadata(base, client_metadata)


async def _ingest_new_youtube(
    video_id: str,
    key_id: str,
    resource_key: str,
    svc: tuple[YouTubeService, YouTubeMetadataService, MinIOStorage, SurrealDBRepository],
    orchestrator: PipelineOrchestrator,
    tags: list[str] | None = None,
    transcript_text: str | None = None,
    client_metadata: dict | None = None,
) -> IngestResponse:
    """Ingest a new YouTube video (transcript + metadata + pipeline)."""
    youtube_service, metadata_service, minio_storage, surreal_repo = svc
    transcript = None
    transcript_language = "en"
    segment_count = 0
    if transcript_text is None:
        transcript = youtube_service.fetch_transcript(video_id)
        transcript_text = transcript.full_text
        stored_transcript_text = transcript.timestamped_text
        transcript_language = transcript.language
        segment_count = len(transcript.segments)
    else:
        stored_transcript_text = transcript_text
        segment_count = 1
    file_path = f"youtube/{video_id}/transcript.txt"

    file_size = await minio_storage.upload(
        file_path,
        io.BytesIO(stored_transcript_text.encode("utf-8")),
        "text/plain",
    )

    yt_metadata = None
    try:
        yt_metadata = metadata_service.fetch_metadata(video_id)
        logger.info("Fetched metadata for video %s: %s", video_id, yt_metadata.title)
    except Exception as e:
        logger.warning("Failed to fetch YouTube metadata for %s: %s", video_id, e)

    title = (
        client_metadata.get("title")
        if client_metadata and client_metadata.get("title")
        else (yt_metadata.title if yt_metadata else f"YouTube: {video_id}")
    )
    seg_count = segment_count
    content_metadata = _build_yt_content_metadata(
        video_id, resource_key, transcript_language, seg_count, yt_metadata, client_metadata
    )
    combined_tags = list(set((yt_metadata.tags if yt_metadata else []) + (tags or [])))

    record = ContentMetadata(
        content_type="youtube",
        title=title,
        mime_type="text/plain",
        file_size=file_size,
        file_path=file_path,
        author=key_id,
        tags=combined_tags,
        metadata=content_metadata,
    )
    created = await surreal_repo.create_content(record)
    content_id = created.id or video_id
    created_at_str = created.created_at.isoformat() if created.created_at else None

    metadata_dict = _merge_client_metadata(
        _build_minio_metadata(
            content_id,
            video_id,
            title,
            yt_metadata,
            (transcript_language, seg_count, len(transcript_text)),
            (file_size, key_id, created_at_str),
        ),
        client_metadata,
    )
    await minio_storage.upload(
        f"youtube/{video_id}/metadata.json",
        io.BytesIO(json.dumps(metadata_dict, indent=2).encode("utf-8")),
        "application/json",
    )

    job = await orchestrator.submit(content_id, transcript_text, "youtube", title, resource_key)
    return IngestResponse(
        content_id=content_id,
        content_type="youtube",
        title=title,
        job_id=job.id if job else None,
    )


async def _ingest_web(
    url: str,
    key_id: str,
    docling_client: DoclingClient,
    minio_storage: MinIOStorage,
    surreal_repo: SurrealDBRepository,
    orchestrator: PipelineOrchestrator,
    tags: list[str] | None = None,
) -> IngestResponse:
    canonical_url = canonicalize_web_url(url)
    url_hash = hashlib.sha256(canonical_url.encode("utf-8")).hexdigest()
    resource_key = f"url:{url_hash}"

    existing = await surreal_repo.find_content_by_resource_key(resource_key)
    if existing and existing.id:
        return IngestResponse(
            content_id=existing.id,
            content_type=existing.content_type,
            title=existing.title or canonical_url,
            job_id=None,
        )

    result = await docling_client.extract_markdown(url)

    file_path = f"web/{url_hash}/content.md"
    file_size = await minio_storage.upload(
        file_path,
        io.BytesIO(result.markdown.encode("utf-8")),
        "text/markdown",
    )

    title = result.title or canonical_url
    metadata = ContentMetadata(
        content_type="web",
        title=title,
        mime_type="text/markdown",
        file_size=file_size,
        file_path=file_path,
        author=key_id,
        tags=tags or [],
        metadata={
            "source_url": url,
            "canonical_url": canonical_url,
            "resource_key": resource_key,
        },
    )
    created = await surreal_repo.create_content(metadata)
    content_id = created.id or url_hash

    job = await orchestrator.submit(content_id, result.markdown, "web", title, resource_key)

    return IngestResponse(
        content_id=content_id,
        content_type="web",
        title=title,
        job_id=job.id if job else None,
    )


def _normalize_netloc(hostname: str | None, port: int | None) -> str:
    """Build netloc from hostname (stripping www.) and optional port."""
    host = (hostname or "").lower()
    if host.startswith("www."):
        host = host[4:]
    return f"{host}:{port}" if port else host


def _canonical_query(query_string: str) -> str:
    """Strip tracking params and sort remaining query params."""
    items = parse_qsl(query_string, keep_blank_values=True)
    filtered = sorted(
        ((k, v) for k, v in items if not _is_tracking_param(k)),
        key=lambda x: (x[0], x[1]),
    )
    return urlencode(filtered, doseq=True)


def canonicalize_web_url(url: str) -> str:
    """Deterministically canonicalize web URLs for dedupe."""
    parsed = urlparse(url)
    netloc = _normalize_netloc(parsed.hostname, parsed.port)
    path = parsed.path or ""
    if path not in {"", "/"} and path.endswith("/"):
        path = path.rstrip("/")
    query = _canonical_query(parsed.query)
    return urlunparse((parsed.scheme, netloc, path, "", query, ""))


def _is_tracking_param(key: str) -> bool:
    lowered = key.lower()
    if lowered.startswith("utm_"):
        return True
    if lowered.endswith("clid"):
        return True
    return lowered in EXPLICIT_TRACKING_PARAMS
