-- Fix vector index dimension (was 384, should be 1024 for mxbai-embed-large)

-- Remove the incorrectly dimensioned index if it exists
REMOVE INDEX IF EXISTS idx_chunk_embedding ON chunk;

-- Create with correct 1024 dimensions
-- CONCURRENTLY builds in background to avoid transaction conflicts on large tables
DEFINE INDEX idx_chunk_embedding ON chunk
    FIELDS embedding
    MTREE DIMENSION 1024
    DIST COSINE
    CONCURRENTLY;
