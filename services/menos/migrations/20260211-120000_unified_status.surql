-- Unified processing status fields (replaces classification_status + entity_extraction_status)
DEFINE FIELD IF NOT EXISTS processing_status ON content TYPE option<string>;
DEFINE FIELD IF NOT EXISTS processed_at ON content TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS pipeline_version ON content TYPE option<string>;
DEFINE INDEX IF NOT EXISTS idx_content_processing_status ON content FIELDS processing_status;
