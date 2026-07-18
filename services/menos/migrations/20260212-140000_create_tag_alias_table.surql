-- Dedicated table for normalized tag alias tracking (variant -> canonical)
DEFINE TABLE IF NOT EXISTS tag_alias SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS variant ON tag_alias TYPE string;
DEFINE FIELD IF NOT EXISTS canonical ON tag_alias TYPE string;
DEFINE FIELD IF NOT EXISTS count ON tag_alias TYPE int DEFAULT 1;
DEFINE FIELD IF NOT EXISTS updated_at ON tag_alias TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_tag_alias_pair_unique ON tag_alias FIELDS variant, canonical UNIQUE;
DEFINE INDEX IF NOT EXISTS idx_tag_alias_count ON tag_alias FIELDS count;
DEFINE INDEX IF NOT EXISTS idx_tag_alias_updated_at ON tag_alias FIELDS updated_at;
