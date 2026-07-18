-- Add link edge table for document relationships
-- Supports wiki links, external URLs, and markdown references

-- Link table: stores edges between content items
DEFINE TABLE IF NOT EXISTS link SCHEMAFULL;

-- Reference to source content item
DEFINE FIELD IF NOT EXISTS source ON link TYPE record<content>;

-- Reference to target content item
DEFINE FIELD IF NOT EXISTS target ON link TYPE record<content>;

-- Display text for the link (anchor text, URL label, etc.)
DEFINE FIELD IF NOT EXISTS link_text ON link TYPE string;

-- Type of relationship: wiki, url, markdown, or custom
DEFINE FIELD IF NOT EXISTS link_type ON link TYPE string;

-- Timestamp when link was created
DEFINE FIELD IF NOT EXISTS created_at ON link TYPE datetime DEFAULT time::now();

-- Indexes for efficient graph traversal
-- Fast lookups of all links originating from a source
DEFINE INDEX IF NOT EXISTS idx_link_source ON link FIELDS source;

-- Fast lookups of all links pointing to a target
DEFINE INDEX IF NOT EXISTS idx_link_target ON link FIELDS target;
