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
