-- Add quality tier field on content metadata
DEFINE FIELD IF NOT EXISTS tier ON content TYPE option<string>;
