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
