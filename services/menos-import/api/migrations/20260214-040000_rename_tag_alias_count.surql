-- Rename 'count' to 'usage_count' on tag_alias (count is a SurrealDB reserved word)
DEFINE FIELD IF NOT EXISTS usage_count ON tag_alias TYPE int DEFAULT 1;
UPDATE tag_alias SET usage_count = count;
REMOVE FIELD count ON tag_alias;

REMOVE INDEX idx_tag_alias_count ON tag_alias;
DEFINE INDEX IF NOT EXISTS idx_tag_alias_usage_count ON tag_alias FIELDS usage_count;
