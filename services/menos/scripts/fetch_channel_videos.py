"""Fetch YouTube channel videos and export to CSV.

Fetches video information from a YouTube channel using the YouTube Data API v3
and exports the results to a CSV file.

Usage:
    PYTHONPATH=. uv run python scripts/fetch_channel_videos.py CHANNEL_URL
    PYTHONPATH=. uv run python scripts/fetch_channel_videos.py CHANNEL_URL --months 6
    PYTHONPATH=. uv run python scripts/fetch_channel_videos.py CHANNEL_URL -o output.csv
"""

import argparse
import csv
import re
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from googleapiclient.errors import HttpError

from menos.services.youtube_metadata import YouTubeMetadataService, format_duration


def get_channel_id(youtube: Any, channel_url: str) -> str | None:
    """Extract channel ID from a YouTube channel URL.

    Supports @username URLs (e.g., https://www.youtube.com/@NateBJones).
    """
    if "@" not in channel_url:
        print(f"Could not extract username from URL: {channel_url}")
        return None

    username = channel_url.split("@")[1].split("/")[0]

    try:
        request = youtube.search().list(
            part="snippet",
            q=username,
            type="channel",
            maxResults=1,
        )
        response = request.execute()

        if response.get("items"):
            return response["items"][0]["snippet"]["channelId"]

        print(f"No channel found for username: {username}")
        return None
    except HttpError as e:
        print(f"YouTube API error: {e}")
        return None


def _get_uploads_playlist_id(youtube: Any, channel_id: str) -> str | None:
    """Return the uploads playlist ID for a channel, or None if not found."""
    request = youtube.channels().list(part="contentDetails", id=channel_id)
    response = request.execute()
    if not response.get("items"):
        print(f"No channel found with ID: {channel_id}")
        return None
    return response["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]


def _fetch_playlist_page(
    youtube: Any, playlist_id: str, cutoff_date: datetime, page_token: str | None
) -> tuple[list[str], dict[str, datetime], str | None]:
    """Fetch one page of playlist items newer than cutoff_date.

    Returns (video_ids, video_dates, next_page_token).
    """
    response = (
        youtube.playlistItems()
        .list(
            part="snippet,contentDetails",
            playlistId=playlist_id,
            maxResults=50,
            pageToken=page_token,
        )
        .execute()
    )

    video_ids: list[str] = []
    video_dates: dict[str, datetime] = {}
    for item in response.get("items", []):
        vid = item["contentDetails"]["videoId"]
        published_at = datetime.strptime(item["snippet"]["publishedAt"], "%Y-%m-%dT%H:%M:%SZ")
        if published_at >= cutoff_date:
            video_ids.append(vid)
            video_dates[vid] = published_at
        else:
            return video_ids, video_dates, None  # ordered by date — stop early

    return video_ids, video_dates, response.get("nextPageToken")


def _fetch_video_details(
    youtube: Any, video_ids: list[str], video_dates: dict[str, datetime]
) -> list[dict[str, Any]]:
    """Fetch detailed info for a batch of video IDs."""
    response = (
        youtube.videos()
        .list(
            part="snippet,statistics,contentDetails",
            id=",".join(video_ids),
        )
        .execute()
    )

    results = []
    for video in response.get("items", []):
        vid = video["id"]
        snippet = video["snippet"]
        statistics = video.get("statistics", {})
        results.append(
            {
                "title": snippet["title"],
                "url": f"https://www.youtube.com/watch?v={vid}",
                "upload_date": video_dates[vid].strftime("%Y-%m-%d"),
                "view_count": statistics.get("viewCount", "0"),
                "duration": video["contentDetails"]["duration"],
                "description": snippet.get("description", "")[:200],
            }
        )
    return results


def get_channel_videos(
    youtube: Any,
    channel_id: str,
    cutoff_date: datetime,
) -> list[dict[str, Any]]:
    """Fetch all videos from a channel since the cutoff date."""
    videos: list[dict[str, Any]] = []
    try:
        playlist_id = _get_uploads_playlist_id(youtube, channel_id)
        if not playlist_id:
            return videos

        next_page_token: str | None = None
        while True:
            video_ids, video_dates, next_page_token = _fetch_playlist_page(
                youtube, playlist_id, cutoff_date, next_page_token
            )
            if video_ids:
                videos.extend(_fetch_video_details(youtube, video_ids, video_dates))
            if not next_page_token or not video_ids:
                break

        videos.sort(key=lambda x: x["upload_date"], reverse=True)
    except HttpError as e:
        print(f"YouTube API error: {e}")

    return videos


def save_to_csv(videos: list[dict[str, Any]], filename: str) -> None:
    """Save videos to a CSV file."""
    if not videos:
        print("No videos to save.")
        return

    with open(filename, "w", newline="", encoding="utf-8") as csvfile:
        fieldnames = ["title", "url", "upload_date", "view_count", "duration", "description"]
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)

        writer.writeheader()
        for video in videos:
            video["duration"] = format_duration(video["duration"])
            writer.writerow(video)

    print(f"Saved {len(videos)} videos to {filename}")


def main() -> None:
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Fetch YouTube channel videos and export to CSV")
    parser.add_argument(
        "channel_url",
        help="YouTube channel URL (e.g., https://www.youtube.com/@ChannelName)",
    )
    parser.add_argument(
        "-o",
        "--output",
        help="Output CSV filename (auto-generated from channel name if not provided)",
    )
    parser.add_argument(
        "-m",
        "--months",
        type=int,
        default=12,
        help="Number of months to look back (default: 12)",
    )

    args = parser.parse_args()

    # Use YouTubeMetadataService for API client access
    metadata_service = YouTubeMetadataService()
    youtube = metadata_service._get_client()

    # Determine output file
    data_dir = Path(__file__).parent.parent.parent / "data"
    data_dir.mkdir(parents=True, exist_ok=True)

    if args.output:
        output_file = data_dir / args.output
    else:
        if "@" not in args.channel_url:
            print("Error: Could not extract channel name from URL")
            print("Please use -o to specify output filename")
            sys.exit(1)

        username = args.channel_url.split("@")[1].split("/")[0]
        # Convert CamelCase to snake_case for filename
        snake_name = re.sub(r"(?<=[a-z0-9])([A-Z])", r"_\1", username).lower()
        snake_name = snake_name.replace("-", "_")
        output_file = data_dir / f"{snake_name}_videos.csv"

    # Calculate cutoff date
    cutoff_date = datetime.now() - timedelta(days=args.months * 30)

    print(f"Fetching videos from: {args.channel_url}")
    print(f"Cutoff date: {cutoff_date.strftime('%Y-%m-%d')}")

    # Get channel ID
    print("Looking up channel ID...")
    channel_id = get_channel_id(youtube, args.channel_url)
    if not channel_id:
        print("Could not find channel. Please check the URL.")
        sys.exit(1)

    print(f"Found channel ID: {channel_id}")

    # Fetch videos
    print("Fetching videos...")
    videos = get_channel_videos(youtube, channel_id, cutoff_date)

    if not videos:
        print("No videos found in the specified time range.")
        sys.exit(0)

    print(f"Found {len(videos)} videos from the last {args.months} months.")

    # Save to CSV
    save_to_csv(videos, str(output_file))
    print(f"\nDone! CSV saved at: {output_file}")


if __name__ == "__main__":
    main()
