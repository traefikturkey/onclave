"""YouTube discovery endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.services.youtube_metadata import (
    YouTubeMetadataService,
    get_youtube_metadata_service,
)

router = APIRouter(prefix="/youtube", tags=["youtube"])


class ChannelVideoResponse(BaseModel):
    """YouTube channel video list item."""

    video_id: str
    title: str
    url: str
    published_at: str
    duration: str | None = None
    duration_seconds: int | None = None
    view_count: int | None = None


class ChannelVideosResponse(BaseModel):
    """YouTube channel videos response."""

    channel: str
    count: int
    videos: list[ChannelVideoResponse]


@router.get("/channel", response_model=ChannelVideosResponse)
async def list_channel_videos(
    channel: Annotated[str, Query(description="YouTube @handle or @handle URL")],
    key_id: AuthenticatedKeyId,
    limit: Annotated[int, Query(ge=1, le=500)] = 50,
    metadata_service: YouTubeMetadataService = Depends(get_youtube_metadata_service),
):
    """List recent uploads for a YouTube channel."""
    try:
        videos = metadata_service.fetch_channel_videos(channel, limit=limit)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return ChannelVideosResponse(
        channel=channel,
        count=len(videos),
        videos=[ChannelVideoResponse(**video.to_dict()) for video in videos],
    )
