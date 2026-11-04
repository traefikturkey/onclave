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
    request_payload jsonb,
    claim_token text,
    lease_expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_job_resource_key ON pipeline_job (resource_key);
CREATE INDEX IF NOT EXISTS idx_job_content_id ON pipeline_job (content_id);
CREATE INDEX IF NOT EXISTS idx_job_status ON pipeline_job (status);
CREATE INDEX IF NOT EXISTS idx_pipeline_job_recovery ON pipeline_job (status, lease_expires_at, created_at);

CREATE TABLE IF NOT EXISTS pipeline_job_delivery (
    id text PRIMARY KEY,
    job_id text NOT NULL REFERENCES pipeline_job(id) ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('callback', 'notification')),
    target text NOT NULL,
    idempotency_key text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered')),
    attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_token text,
    lease_expires_at timestamptz,
    last_error_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_pipeline_job_delivery_due
    ON pipeline_job_delivery (next_attempt_at, created_at, id)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pipeline_job_delivery_lease
    ON pipeline_job_delivery (lease_expires_at, created_at, id)
    WHERE status = 'processing';

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

CREATE TABLE IF NOT EXISTS youtube_logical_content (
    id text PRIMARY KEY,
    youtube_video_id text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS youtube_transcript_version (
    id text PRIMARY KEY,
    logical_content_id text NOT NULL REFERENCES youtube_logical_content(id) ON DELETE CASCADE,
    canonicalization_version text NOT NULL CHECK (canonicalization_version <> ''),
    sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    object_key text GENERATED ALWAYS AS (canonicalization_version || ':' || sha256) STORED,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (logical_content_id, canonicalization_version, sha256),
    UNIQUE (logical_content_id, id)
);
CREATE INDEX IF NOT EXISTS idx_youtube_transcript_version_history
    ON youtube_transcript_version (logical_content_id, created_at, id);

CREATE OR REPLACE FUNCTION prevent_youtube_transcript_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'youtube_transcript_version rows are immutable';
END;
$$;

DROP TRIGGER IF EXISTS youtube_transcript_version_immutable ON youtube_transcript_version;
CREATE TRIGGER youtube_transcript_version_immutable
    BEFORE UPDATE OR DELETE ON youtube_transcript_version
    FOR EACH ROW
    EXECUTE FUNCTION prevent_youtube_transcript_version_mutation();

CREATE TABLE IF NOT EXISTS youtube_transcript_current (
    logical_content_id text PRIMARY KEY
        REFERENCES youtube_logical_content(id) ON DELETE CASCADE,
    version_id text NOT NULL,
    FOREIGN KEY (logical_content_id, version_id)
        REFERENCES youtube_transcript_version (logical_content_id, id)
        ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS improvement_record (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('feedback','failure','knowledge','analysis','classification','review','note')),
    project text,
    body text NOT NULL,
    source_ids text[] NOT NULL DEFAULT '{}',
    source_paths text[] NOT NULL DEFAULT '{}',
    provenance jsonb NOT NULL DEFAULT '{}',
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS improvement_record_updated_idx ON improvement_record (updated_at DESC, id);
CREATE INDEX IF NOT EXISTS improvement_record_kind_idx ON improvement_record (kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS improvement_record_project_idx ON improvement_record (project, updated_at DESC);
CREATE INDEX IF NOT EXISTS improvement_record_text_idx ON improvement_record USING gin (to_tsvector('simple', body));

-- Native raw archives are independent of content processing and improvements.
CREATE TABLE IF NOT EXISTS archive_chunk (
    sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    size integer NOT NULL CHECK (size BETWEEN 1 AND 1048576),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (sha256, size)
);
CREATE TABLE IF NOT EXISTS archive_manifest (
    id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
    source jsonb NOT NULL,
    byte_length bigint NOT NULL CHECK (byte_length BETWEEN 0 AND 8589934592),
    canonical text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS archive_manifest_source_idx ON archive_manifest
    ((source->>'source_type'), (source->>'uploader_machine_id'), (source->>'profile'), id);
CREATE INDEX IF NOT EXISTS archive_manifest_session_idx ON archive_manifest ((source->>'session_id'), id);
CREATE TABLE IF NOT EXISTS archive_manifest_chunk (
    manifest_id text NOT NULL REFERENCES archive_manifest(id),
    chunk_index integer NOT NULL CHECK (chunk_index BETWEEN 0 AND 8191),
    sha256 text NOT NULL,
    size integer NOT NULL,
    PRIMARY KEY (manifest_id, chunk_index),
    FOREIGN KEY (sha256, size) REFERENCES archive_chunk(sha256, size)
);
