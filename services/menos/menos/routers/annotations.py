"""Content annotation endpoints."""

import hashlib
import io
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.models import ContentMetadata
from menos.services.di import get_minio_storage, get_surreal_repo
from menos.services.storage import MinIOStorage, SurrealDBRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/content", tags=["annotations"])


class AnnotationCreate(BaseModel):
    """Request body for creating an annotation."""

    text: str
    title: str | None = None
    source_type: str = "screenshot"
    tags: list[str] = []


class AnnotationResponse(BaseModel):
    """Response for a single annotation."""

    id: str
    parent_content_id: str
    text: str
    title: str | None = None
    source_type: str = "screenshot"
    tags: list[str] = []
    created_at: datetime | None = None


@router.post("/{content_id}/annotations", response_model=AnnotationResponse)
async def create_annotation(
    content_id: str,
    body: AnnotationCreate,
    key_id: AuthenticatedKeyId,
    minio_storage: MinIOStorage = Depends(get_minio_storage),
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Create an annotation for a content item."""
    # Validate parent exists
    parent = await surreal_repo.get_content(content_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Content not found")

    # Generate unique ID for annotation
    timestamp = datetime.now(UTC).isoformat()
    hash_input = f"{body.text}{timestamp}".encode()
    generated_id = hashlib.sha256(hash_input).hexdigest()[:12]

    # Store text in MinIO
    file_path = f"annotations/{content_id}/{generated_id}.md"
    file_size = await minio_storage.upload(
        file_path,
        io.BytesIO(body.text.encode("utf-8")),
        "text/markdown",
    )

    # Create ContentMetadata
    title = body.title or f"Annotation for {parent.title or content_id}"
    metadata = ContentMetadata(
        content_type="annotation",
        title=title,
        mime_type="text/markdown",
        file_size=file_size,
        file_path=file_path,
        author=key_id,
        tags=body.tags,
        metadata={
            "parent_content_id": content_id,
            "source_type": body.source_type,
        },
    )
    created = await surreal_repo.create_content(metadata)

    return AnnotationResponse(
        id=created.id or generated_id,
        parent_content_id=content_id,
        text=body.text,
        title=title,
        source_type=body.source_type,
        tags=body.tags,
        created_at=created.created_at,
    )


@router.get("/{content_id}/annotations", response_model=list[AnnotationResponse])
async def list_annotations(
    content_id: str,
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
    minio_storage: MinIOStorage = Depends(get_minio_storage),
):
    """Get all annotations for a content item."""
    # Find annotations for this parent
    annotations = await surreal_repo.find_content_by_parent_id(
        content_id, content_type="annotation"
    )

    # Load text from MinIO for each annotation
    responses = []
    for ann in annotations:
        try:
            text_bytes = await minio_storage.download(ann.file_path)
            text = text_bytes.decode("utf-8")
        except Exception as e:
            logger.warning("Failed to load annotation text from %s: %s", ann.file_path, e)
            text = ""

        metadata = ann.metadata or {}
        responses.append(
            AnnotationResponse(
                id=ann.id or "",
                parent_content_id=metadata.get("parent_content_id", content_id),
                text=text,
                title=ann.title,
                source_type=metadata.get("source_type", "screenshot"),
                tags=ann.tags,
                created_at=ann.created_at,
            )
        )

    return responses
