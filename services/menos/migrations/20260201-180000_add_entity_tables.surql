-- Entity extraction and knowledge graph tables
-- Adds entity table, content_entity edge table, and entity extraction status

-- Entity table: stores extracted entities (topics, repos, papers, tools, persons)
DEFINE TABLE IF NOT EXISTS entity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS entity_type ON entity TYPE string;  -- topic, repo, paper, tool, person
DEFINE FIELD IF NOT EXISTS name ON entity TYPE string;         -- Display name
DEFINE FIELD IF NOT EXISTS normalized_name ON entity TYPE string;  -- For matching (lowercase, no separators)
DEFINE FIELD IF NOT EXISTS description ON entity TYPE option<string>;
DEFINE FIELD IF NOT EXISTS hierarchy ON entity TYPE option<array<string>>;  -- ["AI", "LLMs", "RAG"] breadcrumb
DEFINE FIELD IF NOT EXISTS metadata ON entity TYPE option<object>;
-- For repos: { url, owner, stars, language, topics, fetched_at }
-- For papers: { url, arxiv_id, doi, authors, abstract, published_at, fetched_at }
-- For topics: { aliases, parent_topic }
-- For tools: { url, category }
DEFINE FIELD IF NOT EXISTS created_at ON entity TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS updated_at ON entity TYPE datetime DEFAULT time::now();
DEFINE FIELD IF NOT EXISTS source ON entity TYPE string;  -- ai_extracted, user_created, api_fetched

-- Entity indexes
DEFINE INDEX IF NOT EXISTS idx_entity_type ON entity FIELDS entity_type;
DEFINE INDEX IF NOT EXISTS idx_entity_normalized ON entity FIELDS normalized_name;
DEFINE INDEX IF NOT EXISTS idx_entity_hierarchy ON entity FIELDS hierarchy;

-- Content-Entity edge table: stores relationships between content and entities
DEFINE TABLE IF NOT EXISTS content_entity SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS content_id ON content_entity TYPE record<content>;
DEFINE FIELD IF NOT EXISTS entity_id ON content_entity TYPE record<entity>;
DEFINE FIELD IF NOT EXISTS edge_type ON content_entity TYPE string;  -- discusses, mentions, cites, uses, demonstrates
DEFINE FIELD IF NOT EXISTS confidence ON content_entity TYPE option<float>;  -- 0.0-1.0 extraction confidence
DEFINE FIELD IF NOT EXISTS mention_count ON content_entity TYPE option<int>;  -- How many times mentioned
DEFINE FIELD IF NOT EXISTS source ON content_entity TYPE string;  -- ai_extracted, url_detected, user_added
DEFINE FIELD IF NOT EXISTS created_at ON content_entity TYPE datetime DEFAULT time::now();

-- Content-Entity edge indexes for traversal
DEFINE INDEX IF NOT EXISTS idx_ce_content ON content_entity FIELDS content_id;
DEFINE INDEX IF NOT EXISTS idx_ce_entity ON content_entity FIELDS entity_id;
DEFINE INDEX IF NOT EXISTS idx_ce_type ON content_entity FIELDS edge_type;
-- Unique constraint: one edge per content-entity-edgetype combination
DEFINE INDEX IF NOT EXISTS idx_ce_unique ON content_entity FIELDS content_id, entity_id, edge_type UNIQUE;

-- Add entity extraction status fields to content table
DEFINE FIELD IF NOT EXISTS entity_extraction_status ON content TYPE option<string>;  -- pending, processing, completed, failed
DEFINE FIELD IF NOT EXISTS entity_extraction_at ON content TYPE option<datetime>;
