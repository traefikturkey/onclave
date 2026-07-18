-- Classification status tracking and queryable fields
DEFINE FIELD IF NOT EXISTS classification_status ON content TYPE option<string>;
DEFINE FIELD IF NOT EXISTS classification_at ON content TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS classification_tier ON content TYPE option<string>;
DEFINE FIELD IF NOT EXISTS classification_score ON content TYPE option<int>;
-- Index for tier-based filtering
DEFINE INDEX IF NOT EXISTS idx_content_classification_tier ON content FIELDS classification_tier;
