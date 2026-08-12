export enum EntityType {
  TOPIC = "topic",
  REPO = "repo",
  PAPER = "paper",
  TOOL = "tool",
  PERSON = "person",
}

export enum EdgeType {
  DISCUSSES = "discusses",
  MENTIONS = "mentions",
  CITES = "cites",
  USES = "uses",
  DEMONSTRATES = "demonstrates",
}

export enum EntitySource {
  AI_EXTRACTED = "ai_extracted",
  URL_DETECTED = "url_detected",
  USER_CREATED = "user_created",
  API_FETCHED = "api_fetched",
}

export enum JobStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  FAILED = "failed",
  CANCELLED = "cancelled",
}

export enum DataTier {
  COMPACT = "compact",
  FULL = "full",
}

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type PipelineJob = {
  id?: string;
  resource_key: string;
  content_id: string;
  status?: JobStatus;
  pipeline_version?: string;
  data_tier?: DataTier;
  error_code?: string | null;
  error_message?: string | null;
  error_stage?: string | null;
  metadata?: JsonObject;
  created_at?: Date | null;
  started_at?: Date | null;
  finished_at?: Date | null;
};

export type ChunkModel = {
  id?: string;
  content_id: string;
  text: string;
  chunk_index: number;
  embedding?: number[] | null;
  created_at?: Date | null;
};

export type ContentMetadata = {
  id?: string;
  content_type: string;
  title?: string | null;
  description?: string | null;
  mime_type: string;
  file_size: number;
  file_path: string;
  author?: string | null;
  tags?: string[];
  tier?: string | null;
  created_at?: Date | null;
  updated_at?: Date | null;
  metadata?: JsonObject;
};

export type RelatedContent = {
  content_id: string;
  title: string;
  content_type: string;
  shared_entity_count: number;
  shared_entities: string[];
};

export type LinkModel = {
  id?: string;
  source: string;
  target?: string | null;
  link_text: string;
  link_type: string;
  created_at?: Date | null;
};

export type EntityModel = {
  id?: string;
  entity_type: EntityType;
  name: string;
  normalized_name: string;
  description?: string | null;
  hierarchy?: string[] | null;
  metadata?: JsonObject;
  created_at?: Date | null;
  updated_at?: Date | null;
  source?: EntitySource;
};

export type ContentEntityEdge = {
  id?: string;
  content_id: string;
  entity_id: string;
  edge_type: EdgeType;
  confidence?: number | null;
  mention_count?: number | null;
  source?: EntitySource;
  created_at?: Date | null;
};

export type ExtractedEntity = {
  entity_type: EntityType;
  name: string;
  confidence: string;
  edge_type: EdgeType;
  hierarchy?: string[] | null;
};

export type PreDetectedValidation = {
  entity_id: string;
  edge_type: EdgeType;
  confirmed: boolean;
};

export type UnifiedResult = {
  tags?: string[];
  new_tags?: string[];
  tier?: string;
  tier_explanation?: string[];
  quality_score?: number;
  score_explanation?: string[];
  summary?: string;
  topics?: ExtractedEntity[];
  pre_detected_validations?: PreDetectedValidation[];
  additional_entities?: ExtractedEntity[];
  model?: string;
  processed_at?: string;
};

export type JobTiming = readonly [Date | null | undefined, Date | null | undefined];
export type JobErrors = readonly [string | null | undefined, string | null | undefined, string | null | undefined];

export type LlmUsage = {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  estimated_cost: number;
  context: JsonObject;
  duration_ms: number;
  pricing_snapshot_refreshed_at?: Date | null;
  created_at?: Date | null;
};
