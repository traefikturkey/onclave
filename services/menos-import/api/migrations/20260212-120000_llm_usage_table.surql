-- LLM usage metering table for token and cost tracking
DEFINE TABLE IF NOT EXISTS llm_usage SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS provider ON llm_usage TYPE string;
DEFINE FIELD IF NOT EXISTS model ON llm_usage TYPE string;
DEFINE FIELD IF NOT EXISTS input_tokens ON llm_usage TYPE int;
DEFINE FIELD IF NOT EXISTS output_tokens ON llm_usage TYPE int;
DEFINE FIELD IF NOT EXISTS input_price_per_million ON llm_usage TYPE float;
DEFINE FIELD IF NOT EXISTS output_price_per_million ON llm_usage TYPE float;
DEFINE FIELD IF NOT EXISTS estimated_cost ON llm_usage TYPE float;
DEFINE FIELD IF NOT EXISTS context ON llm_usage TYPE string;
DEFINE FIELD IF NOT EXISTS duration_ms ON llm_usage TYPE int;
DEFINE FIELD IF NOT EXISTS pricing_snapshot_refreshed_at ON llm_usage TYPE option<datetime>;
DEFINE FIELD IF NOT EXISTS created_at ON llm_usage TYPE datetime DEFAULT time::now();

DEFINE INDEX IF NOT EXISTS idx_llm_usage_created_at ON llm_usage FIELDS created_at;
