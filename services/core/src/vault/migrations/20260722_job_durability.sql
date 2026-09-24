CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pipeline_job ADD COLUMN IF NOT EXISTS request_payload jsonb;
ALTER TABLE pipeline_job ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE pipeline_job ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_pipeline_job_recovery
    ON pipeline_job (status, lease_expires_at, created_at);

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

INSERT INTO schema_migration (name)
VALUES ('20260722_job_durability')
ON CONFLICT (name) DO NOTHING;
