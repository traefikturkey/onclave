-- Initial schema definition for menos
-- Defines content and chunk tables with their fields

-- Content table: stores metadata for all content items
DEFINE TABLE IF NOT EXISTS content SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content_type ON content TYPE string;
DEFINE FIELD IF NOT EXISTS title ON content TYPE option<string>;
DEFINE FIELD IF NOT EXISTS description ON content TYPE option<string>;
DEFINE FIELD IF NOT EXISTS mime_type ON content TYPE string;
DEFINE FIELD IF NOT EXISTS file_size ON content TYPE int;
DEFINE FIELD IF NOT EXISTS file_path ON content TYPE string;
DEFINE FIELD IF NOT EXISTS author ON content TYPE string;
DEFINE FIELD IF NOT EXISTS tags ON content TYPE array DEFAULT [];
DEFINE FIELD IF NOT EXISTS created_at ON content TYPE datetime;
DEFINE FIELD IF NOT EXISTS updated_at ON content TYPE datetime;
DEFINE FIELD IF NOT EXISTS metadata ON content TYPE object DEFAULT {};

-- Chunk table: stores chunked content with embeddings for vector search
DEFINE TABLE IF NOT EXISTS chunk SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content_id ON chunk TYPE string;
DEFINE FIELD IF NOT EXISTS text ON chunk TYPE string;
DEFINE FIELD IF NOT EXISTS chunk_index ON chunk TYPE int;
DEFINE FIELD IF NOT EXISTS embedding ON chunk TYPE option<array<float>>;
DEFINE FIELD IF NOT EXISTS created_at ON chunk TYPE datetime;
