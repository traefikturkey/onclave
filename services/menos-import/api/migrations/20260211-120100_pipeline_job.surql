-- Pipeline job table for job-first authority model
DEFINE TABLE IF NOT EXISTS pipeline_job SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS resource_key ON pipeline_job TYPE string;
DEFINE FIELD IF NOT EXISTS content_id ON pipeline_job TYPE record<content>;
DEFINE FIELD IF NOT EXISTS status ON pipeline_job TYPE string;
DEFINE FIELD IF NOT EXISTS pipeline_version ON pipeline_job TYPE string;
DEFINE FIELD IF NOT EXISTS data_tier ON pipeline_job TYPE string DEFAULT 'compact';
DEFINE FIELD IF NOT EXISTS idempotency_key ON pipeline_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_code ON pipeline_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_message ON pipeline_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS error_stage ON pipeline_job TYPE option<string>;
DEFINE FIELD IF NOT EXISTS metadata ON pipeline_job TYPE option<object>;
DEFINE FIELD IF NOT EXISTS created_at ON pipeline_job TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS started_at ON pipeline_job TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS finished_at ON pipeline_job TYPE option<datetime>;

-- Indexes
DEFINE INDEX IF NOT EXISTS idx_job_resource_key ON pipeline_job FIELDS resource_key;
DEFINE INDEX IF NOT EXISTS idx_job_content_id ON pipeline_job FIELDS content_id;
DEFINE INDEX IF NOT EXISTS idx_job_status ON pipeline_job FIELDS status;
DEFINE INDEX IF NOT EXISTS idx_job_idempotency ON pipeline_job FIELDS idempotency_key UNIQUE;
