-- Backfill resource_key for all YouTube content records ingested before
-- the resource_key dedup system was introduced (2026-02-11).
-- This closes the dedup gap so re-ingesting old videos doesn't create duplicates.
UPDATE content SET metadata.resource_key = string::concat("yt:", metadata.video_id)
WHERE content_type = 'youtube'
  AND metadata.resource_key IS NONE
  AND metadata.video_id IS NOT NONE;
