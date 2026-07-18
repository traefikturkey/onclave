# Recommendation Engine Specification

Specification for semantic search, content recommendations, and preference learning in menos.

---

## 1. High-Level Goals

Index content (primarily YouTube transcripts and web pages) so the system can:

1. **Search semantically** across chunks of content
2. **Model user preferences** and recommend content
3. **Suggest applicable content** for current projects/problems (Phase 5)

To accomplish this, every content item should have **two types of embeddings**:

1. A **global embedding** (one vector per item) representing the whole document
2. Multiple **chunk embeddings** (many vectors per item) representing local regions

These representations enable different retrieval modes for different tasks.

---

## 2. Embedding Models

### 2.1 Global Embedding Model

- **Model**: `mxbai-embed-large` (via Ollama)
- **Role**: Global / whole-document embeddings
- **Output dimension**: 1024

Use this model to create **one vector per content item** (video transcript, article, etc.).

Global vectors are used for:
- Recommendations
- Preference learning
- Application suggester
- Feed ranking

### 2.2 Chunk Embedding Model

- **Model**: `mxbai-embed-large` (via Ollama) - same model for consistency
- **Role**: Chunk-level embeddings for semantic search
- **Output dimension**: 1024

Use this model for **all chunks** produced from content.

Chunk vectors are used for:
- Semantic search
- Question-specific retrieval
- Concept extraction and tagging
- Locating most relevant passages

---

## 3. Content Types

### YouTube Transcripts
- Use **time + token chunking** (not structural chunking)
- Preserve timestamps for video navigation

### Web Content
- Use **structural chunking** respecting headings/paragraphs
- Track character offsets for source linking

---

## 4. Storage in SurrealDB

### 4.1 Content Table (Global Level)

One record per logical content item (video, article).

**Schema**:
```surql
DEFINE TABLE content SCHEMAFULL;
DEFINE FIELD id ON content TYPE string;
DEFINE FIELD type ON content TYPE string;  -- "youtube_video", "web_article"
DEFINE FIELD title ON content TYPE string;
DEFINE FIELD source ON content TYPE string;  -- channel/site name
DEFINE FIELD url ON content TYPE string;
DEFINE FIELD summary ON content TYPE option<string>;
DEFINE FIELD tags ON content TYPE array<string>;
DEFINE FIELD created_at ON content TYPE datetime;
DEFINE FIELD rating ON content TYPE option<int>;
DEFINE FIELD importance ON content TYPE option<string>;
DEFINE FIELD projects ON content TYPE array<string>;
DEFINE FIELD embedding ON content TYPE array<float>;  -- 1024-dim global embedding

DEFINE INDEX content_embedding_idx ON content FIELDS embedding MTREE DIMENSION 1024;
```

### 4.2 Content Chunks Table (Chunk Level)

Multiple records per content item.

**Schema**:
```surql
DEFINE TABLE content_chunk SCHEMAFULL;
DEFINE FIELD id ON content_chunk TYPE string;
DEFINE FIELD content_id ON content_chunk TYPE record<content>;
DEFINE FIELD chunk_index ON content_chunk TYPE int;
DEFINE FIELD text ON content_chunk TYPE string;
DEFINE FIELD start_char ON content_chunk TYPE option<int>;
DEFINE FIELD end_char ON content_chunk TYPE option<int>;
DEFINE FIELD start_time ON content_chunk TYPE option<float>;  -- for YouTube
DEFINE FIELD end_time ON content_chunk TYPE option<float>;
DEFINE FIELD embedding ON content_chunk TYPE array<float>;  -- 1024-dim chunk embedding

DEFINE INDEX chunk_embedding_idx ON content_chunk FIELDS embedding MTREE DIMENSION 1024;
DEFINE INDEX chunk_content_idx ON content_chunk FIELDS content_id;
```

---

## 5. Chunking Strategies

### 5.1 YouTube Transcripts (Time + Token Hybrid)

Transcripts are flat lists of segments with timestamps:
```json
{
  "start": 12.34,
  "duration": 5.43,
  "text": "..."
}
```

**Algorithm**:

1. Convert transcript segments to sequence of text units with timestamps
2. Tokenize text (approximate: 4 chars ≈ 1 token)
3. Iterate through segments, accumulate into buffer while:
   - total tokens in buffer < ~2,000–3,000 tokens, AND
   - no large pause has been hit
4. A "large pause" is when `next.start - current_end > 8-10 seconds`
5. When either limit hit, finalize chunk:
   - Chunk text = concatenation of segment texts
   - Chunk `start_time` = start of first segment
   - Chunk `end_time` = end of last segment
6. Optionally add small overlap (last 1-2 segments from previous chunk)
7. For extremely long videos (>8,192 tokens total):
   - Logic naturally produces multiple chunks
   - Individual chunks stay under ~6-7k tokens

### 5.2 Web Content (Structural)

1. Parse HTML/Markdown into structured form
2. Chunk respecting:
   - headings/sections
   - paragraphs
   - code blocks
3. Target chunk size ~1,000–2,000 tokens (hard cap well below 8,192)
4. For each chunk:
   - Extract chunk text
   - Track `start_char`/`end_char` offsets
   - Generate `chunk_index`

---

## 6. Global Embedding Generation

### For Items ≤ 8,192 Tokens

1. Build single text string representing whole item:
   - Videos: full transcript text
   - Web pages: cleaned body text
2. Feed to embedding model once
3. Store resulting 1024-dim vector as `embedding` in content table

### For Items > 8,192 Tokens

1. Split full text into **2–3 large slices** (~6-8k tokens each)
2. For each slice, compute embedding
3. Take **mean** of slice embeddings → final `embedding`
4. Store pooled embedding in content table

---

## 7. Retrieval Modes

Different tasks require different weightings in the final score.

### Search Mode ("Find what matches this query")
- `w_chunk` = **high**
- `w_global` = medium
- `w_preference` = low

### Recommendation Mode ("What should I watch next?")
- `w_chunk` = low
- `w_global` = medium
- `w_preference` = **high**

### Application Suggester Mode ("Help with project X")
- `w_chunk` = **high**
- `w_global` = medium
- `w_preference` = medium

---

## 8. Query & Ranking Flow

### Suggested Retrieval Flow (Search / Problem-Solving)

1. **Encode query**:
   - `query_vec` = embed(query_text)

2. **Chunk search**:
   - Use `query_vec` against `content_chunk` table
   - Retrieve top N chunks (e.g., 50–200)

3. **Group by content_id** and compute per-document **chunk score**:
   - max similarity, or
   - top-k mean similarity

4. **Global similarity**:
   - For each candidate content_id, fetch its `embedding`
   - Compute similarity to `query_vec`

5. **Combine signals**:
   ```
   score(doc) = w_chunk * chunk_score
              + w_global * global_score
              + w_preference * preference_score(doc)
   ```

6. **Return ranked documents + key chunks**:
   - For each doc, return top matching chunks (text + timestamps)
   - Enables jumping to relevant video sections

---

## 9. Preference Modeling

### What a Preference Vector Is

A vector representing user taste dimensions:
- a **1024-dim vector** (same as global embeddings)
- built from **liked/rated content**
- updated incrementally with interactions

### How Preferences Are Built

1. Gather all **global embeddings** of highly-rated content
2. Compute preference vector as:
   - mean of embeddings, or
   - weighted mean (higher ratings = higher weight)
3. Store/update preference vector

### How Preferences Influence Ranking

For each candidate document:
1. Compute `preference_similarity = cosine(doc.embedding, preference_vector)`
2. Include in combined score formula

### Final Recommendation Score

```
score(doc) =
    w_chunk  * chunk_similarity(doc)
  + w_global * global_similarity(doc)
  + w_preference * preference_similarity(doc)
```

---

## 10. Ingestion Flow

### For a New YouTube Video

1. **Fetch transcript** via youtube-transcript-api
2. **Build full transcript text**
3. **Create content record**:
   - `id = "youtube:<video_id>"`
   - Fill metadata: title, source, url, etc.
4. **Compute global embedding**:
   - If total tokens ≤ 8,192: embed full transcript
   - Else: split into slices, embed, mean-pool
5. **Chunk transcript** using time + token strategy
6. For each chunk:
   - Compute chunk embedding
   - Create content_chunk record

### For a New Web Article

1. **Fetch page HTML/Markdown**
2. **Parse** into structured form
3. **Flatten** to full-text for global embedding
4. **Create content record** with metadata
5. **Compute global embedding** (same logic as above)
6. **Chunk** respecting structure
7. For each chunk:
   - Compute chunk embedding
   - Create content_chunk record

---

## 11. Implementation Notes

1. **Abstract embedding calls** behind helper functions:
   ```python
   async def embed_text(text: str) -> list[float]:
       """Generate embedding via Ollama"""
       ...
   ```

2. **Keep ingestion idempotent**:
   - If content_id already exists, update instead of duplicate
   - For chunks, delete old chunks for content_id and re-insert

3. **Token estimation**:
   - Use conservative heuristic (4 chars ≈ 1 token)
   - Stay safely under model limits

4. **Forward-compatible payloads**:
   - Easy to add fields like `difficulty`, `style`, `trust_score` later

5. **Logging and metrics**:
   - Number of chunks per doc
   - Average chunk size
   - Embedding latency per item

---

## 12. Integration with Phase 5 Agentic Search

The embedding pipeline feeds into Phase 5 capabilities:

1. **Search Agent**: Uses chunk search for precise retrieval
2. **Recommendation Agent**: Uses global embeddings + preferences
3. **Application Suggester**: Combines chunk search (find techniques) with preference weighting

See `knowledge/architecture/orchestrator.md` for agentic architecture.
