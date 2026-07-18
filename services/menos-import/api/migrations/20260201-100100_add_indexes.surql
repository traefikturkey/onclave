-- Add indexes for query performance

-- Vector index on chunk embeddings for fast similarity search
-- Uses MTREE (M-tree) index with cosine distance for 1024-dimensional mxbai-embed-large vectors
-- NOTE: CONCURRENTLY builds index in background, avoiding transaction conflicts on large tables
-- Monitor progress with: INFO FOR INDEX idx_chunk_embedding ON chunk;
DEFINE INDEX IF NOT EXISTS idx_chunk_embedding ON chunk
    FIELDS embedding
    MTREE DIMENSION 1024
    DIST COSINE
    CONCURRENTLY;

-- BTree index on chunk.content_id for fast chunk retrieval by content
DEFINE INDEX IF NOT EXISTS idx_chunk_content_id ON chunk FIELDS content_id;

-- BTree index on content.content_type for filtering by type
DEFINE INDEX IF NOT EXISTS idx_content_type ON content FIELDS content_type;

-- BTree index on content.created_at for time-based queries
DEFINE INDEX IF NOT EXISTS idx_content_created_at ON content FIELDS created_at;
