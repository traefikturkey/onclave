CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS content (
    id text PRIMARY KEY,
    content_type text NOT NULL,
    title text,
    description text,
    mime_type text NOT NULL,
    file_size bigint NOT NULL CHECK (file_size >= 0),
    file_path text NOT NULL,
    author text,
    tags text[] NOT NULL DEFAULT '{}',
    tier text CHECK (tier IS NULL OR tier IN ('S', 'A', 'B', 'C', 'D')),
    metadata jsonb NOT NULL DEFAULT '{}',
    classification_status text,
    classification_at timestamptz,
    classification_tier text,
    classification_score integer,
    entity_extraction_status text,
    entity_extraction_at timestamptz,
    processing_status text,
    processed_at timestamptz,
    pipeline_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    search_document tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED
);
CREATE INDEX IF NOT EXISTS idx_content_type ON content (content_type);
CREATE INDEX IF NOT EXISTS idx_content_created_at ON content (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_tags ON content USING gin (tags);
CREATE INDEX IF NOT EXISTS idx_content_processing_status ON content (processing_status);
CREATE INDEX IF NOT EXISTS idx_content_title_trgm ON content USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_content_search_document ON content USING gin (search_document);
CREATE INDEX IF NOT EXISTS idx_content_resource_key ON content ((metadata->>'resource_key'));
CREATE INDEX IF NOT EXISTS idx_content_parent_id ON content ((metadata->>'parent_content_id'));

CREATE TABLE IF NOT EXISTS chunk (
    id text PRIMARY KEY,
    content_id text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    text text NOT NULL,
    chunk_index integer NOT NULL CHECK (chunk_index >= 0),
    embedding vector(1024),
    created_at timestamptz NOT NULL DEFAULT now(),
    search_document tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
    UNIQUE (content_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunk_content_id ON chunk (content_id);
CREATE INDEX IF NOT EXISTS idx_chunk_search_document ON chunk USING gin (search_document);

CREATE TABLE IF NOT EXISTS entity (
    id text PRIMARY KEY,
    entity_type text NOT NULL,
    name text NOT NULL,
    normalized_name text NOT NULL,
    description text,
    hierarchy text[],
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    source text NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entity_type ON entity (entity_type);
CREATE INDEX IF NOT EXISTS idx_entity_normalized ON entity (normalized_name);
CREATE INDEX IF NOT EXISTS idx_entity_hierarchy ON entity USING gin (hierarchy);
CREATE INDEX IF NOT EXISTS idx_entity_name_trgm ON entity USING gin (name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS content_entity (
    id text PRIMARY KEY,
    content_id text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    entity_id text NOT NULL REFERENCES entity(id) ON DELETE CASCADE,
    edge_type text NOT NULL,
    confidence double precision CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
    mention_count integer CHECK (mention_count IS NULL OR mention_count >= 0),
    source text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (content_id, entity_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_ce_content ON content_entity (content_id);
CREATE INDEX IF NOT EXISTS idx_ce_entity ON content_entity (entity_id);
CREATE INDEX IF NOT EXISTS idx_ce_type ON content_entity (edge_type);

CREATE TABLE IF NOT EXISTS link (
    id text PRIMARY KEY,
    source text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    target text REFERENCES content(id) ON DELETE SET NULL,
    link_text text NOT NULL,
    link_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_source ON link (source);
CREATE INDEX IF NOT EXISTS idx_link_target ON link (target);

CREATE TABLE IF NOT EXISTS pipeline_job (
    id text PRIMARY KEY,
    resource_key text NOT NULL,
    content_id text NOT NULL REFERENCES content(id) ON DELETE CASCADE,
    status text NOT NULL,
    pipeline_version text NOT NULL,
    data_tier text NOT NULL DEFAULT 'compact' CHECK (data_tier IN ('compact', 'full')),
    idempotency_key text UNIQUE,
    error_code text,
    error_message text,
    error_stage text,
    metadata jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_job_resource_key ON pipeline_job (resource_key);
CREATE INDEX IF NOT EXISTS idx_job_content_id ON pipeline_job (content_id);
CREATE INDEX IF NOT EXISTS idx_job_status ON pipeline_job (status);

CREATE TABLE IF NOT EXISTS llm_usage (
    id text PRIMARY KEY,
    provider text NOT NULL,
    model text NOT NULL,
    input_tokens integer NOT NULL CHECK (input_tokens >= 0),
    output_tokens integer NOT NULL CHECK (output_tokens >= 0),
    input_price_per_million double precision NOT NULL,
    output_price_per_million double precision NOT NULL,
    estimated_cost double precision NOT NULL,
    context text NOT NULL,
    duration_ms integer NOT NULL CHECK (duration_ms >= 0),
    pricing_snapshot_refreshed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage (created_at DESC);

CREATE TABLE IF NOT EXISTS tag_alias (
    id text PRIMARY KEY,
    variant text NOT NULL,
    canonical text NOT NULL,
    usage_count integer NOT NULL DEFAULT 1 CHECK (usage_count > 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (variant, canonical)
);
CREATE INDEX IF NOT EXISTS idx_tag_alias_usage_count ON tag_alias (usage_count DESC);

CREATE TABLE IF NOT EXISTS llm_pricing_snapshot (
    id text PRIMARY KEY,
    pricing jsonb NOT NULL,
    refreshed_at timestamptz NOT NULL,
    source text NOT NULL
);
