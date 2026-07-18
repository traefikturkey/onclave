-- Add BTree index on content.tags for tag filtering
-- This enables fast queries with CONTAINSALL operations on tags

DEFINE INDEX IF NOT EXISTS idx_content_tags ON content FIELDS tags;
