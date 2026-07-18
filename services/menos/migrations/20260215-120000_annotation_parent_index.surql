-- Add index for annotation parent lookups
DEFINE INDEX IF NOT EXISTS idx_content_parent_id
    ON content
    FIELDS metadata.parent_content_id;
