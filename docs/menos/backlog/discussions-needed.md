# Research Discussions Needed

Topics requiring deeper exploration to produce detailed specification documents for menos.

---

## How to Use This Document

Each topic represents a potential research conversation to produce detailed specifications. Use AI conversations or research sessions to explore these topics and produce actionable specs.

**Conversation Template:**
1. **Start with context**: "I'm building a content vault with semantic search. Here's my current architecture..."
2. **Show what you have**: Share relevant parts of menos codebase or existing specs
3. **Ask specific questions**: Focus on algorithms, trade-offs, implementation details
4. **Request a spec**: "Can you write a detailed specification document?"
5. **Iterate on details**: Ask follow-up questions about edge cases, performance, testing

**After the research:**
- Save the spec to `knowledge/specs/<topic>.md`
- Update this document with completion status
- Link from other relevant documents

---

## Priority 1: Core Intelligence (Essential for Phase 5)

### 1. Preference Learning & Recommendation Algorithms

**Status**: Not Started
**Urgency**: High (needed for recommendation engine)

**Why this matters:**
The recommendation engine spec outlines preference learning but doesn't specify *how* to learn from ratings and build recommendations.

**Discussion topics:**
- "How should I design a preference learning system that learns from 1-5 star ratings?"
- "What's the best way to combine semantic similarity + preference scores for recommendations?"
- "Should I use collaborative filtering, content-based filtering, or hybrid approaches?"
- "How do I cold-start when I have no ratings yet?"
- "What's the algorithm for: user rates video 5 stars → infer topic preferences?"

**Expected output document:**
`preference_learning_spec.md` covering:
- Preference vector representation (how to store "user likes X topic")
- Rating → topic interest mapping algorithms
- Recommendation scoring formulas (semantic + preference weighting)
- Feedback loop implementation
- Cold-start strategies (what to recommend before any ratings)
- Testing strategies (how to measure recommendation quality)

**Related files:**
- `knowledge/specs/recommendation-engine.md`
- `knowledge/external-analysis/evermemos-inspiration.md` (living profiles section)

---

### 2. Application Suggester Pattern Matching

**Status**: Not Started
**Urgency**: Medium (killer feature for Phase 5)

**Why this matters:**
This is the "killer feature" - suggesting how learned concepts apply to active projects. No implementation details exist.

**Discussion topics:**
- "How do I extract actionable techniques from content (videos, articles)?"
- "What's the best way to match techniques to project challenges?"
- "Should I use LLM-based extraction or rule-based patterns?"
- "How do I represent a 'technique' in a searchable way?"
- "How do I track which suggestions have been applied and measure success?"
- "How do I learn which suggestions are most useful over time?"

**Expected output document:**
`application_suggester_spec.md` covering:
- Technique schema (name, description, category, applicability criteria)
- Extraction methods (LLM prompt templates, structured output format)
- Matching algorithm (techniques → project needs)
- Feedback loop (track application success rate)
- Example implementations (real technique extraction from video transcript)
- Storage design (where techniques live in SurrealDB)

**Related files:**
- `knowledge/architecture/orchestrator.md`
- `knowledge/external-analysis/evermemos-inspiration.md` (insight extraction)

---

## Priority 2: Search & Retrieval (Critical for Implementation)

### 3. Chunking Strategy for Long-Form Content

**Status**: Not Started
**Urgency**: High (needed for content processing)

**Why this matters:**
The recommendation engine spec mentions "time + token hybrid chunking" but doesn't detail the algorithm.

**Discussion topics:**
- "What's the best chunking strategy for YouTube transcripts with timestamps?"
- "How do I balance chunk size (2-3K tokens) with semantic coherence?"
- "Should I use overlapping chunks? How much overlap?"
- "How do I detect natural pause boundaries in transcripts?"
- "What metadata should I store with each chunk (timestamps, speaker, etc.)?"
- "How does chunking work for webpages vs videos?"

**Expected output document:**
`chunking_strategy_spec.md` covering:
- Algorithm pseudocode (time-aware sliding window)
- Overlap strategy (token count, rationale)
- Boundary detection (sentence breaks, speaker changes, silence detection)
- Metadata schema (start/end timestamps, speaker, chunk_index, parent_id)
- Edge case handling (very short videos, missing timestamps, non-transcript content)
- Chunking for different content types (YouTube, webpages, PDFs)

**Related files:**
- `knowledge/specs/recommendation-engine.md` (chunking section)
- `api/menos/services/chunking.py`

---

### 4. Dual-Collection Retrieval Modes

**Status**: Not Started
**Urgency**: High (foundational for search)

**Why this matters:**
The recommendation spec mentions dual collections (content + content_chunk) but doesn't specify retrieval strategies in detail.

**Discussion topics:**
- "How should I design dual-collection retrieval (global + chunk embeddings)?"
- "What's the best way to combine results from both collections?"
- "How do I balance search (chunk-heavy) vs recommendations (global-heavy)?"
- "Should I use RRF (Reciprocal Rank Fusion) or weighted scoring?"
- "When should I query one collection vs both?"
- "How do I rank results from different collections?"

**Expected output document:**
`retrieval_modes_spec.md` covering:
- Collection schemas (what goes in content vs content_chunk, field-by-field)
- Hybrid search algorithms (RRF, weighted fusion formulas)
- Query routing logic (when to use which mode)
- Result ranking strategies
- Performance optimization (caching, pre-filtering, index tuning)
- Example queries for each mode (search, recommendation, application suggester)

**Related files:**
- `knowledge/specs/recommendation-engine.md`
- `api/menos/services/storage.py`

---

## Priority 3: Automation & Intelligence (Quality of Life)

### 5. Content Monitoring & Auto-Ingestion

**Status**: Not Started
**Urgency**: Medium (nice to have, not blocking)

**Why this matters:**
Manual ingestion doesn't scale. Need automation for monitoring content sources.

**Discussion topics:**
- "What's the best way to monitor YouTube channels for new content?"
- "Should I use polling, webhooks, or RSS feeds?"
- "How do I handle rate limits on YouTube Data API?"
- "What's a good scheduling strategy (hourly, daily, weekly)?"
- "How do I prioritize which content to ingest first?"
- "Should I auto-tag new content or queue for manual review?"

**Expected output document:**
`content_monitoring_spec.md` covering:
- API comparison (YouTube Data API vs RSS vs Webhooks)
- Rate limit handling strategies
- Scheduling recommendations (cron patterns, priorities)
- Queue management (FIFO, priority-based, smart scheduling)
- Error handling (channel deleted, API changes)
- Notification system (new content alerts)

**Related files:**
- `api/menos/services/youtube.py`
- `api/menos/services/youtube_metadata.py`

---

### 6. Cross-Content Pattern Analysis

**Status**: Not Started
**Urgency**: Low (polish feature, not MVP)

**Why this matters:**
Identify patterns across content over time - what topics are trending, what's a creator focusing on.

**Discussion topics:**
- "How do I detect emerging topics across a creator's content over time?"
- "What's the best way to identify topic shifts (e.g., 'creator focusing more on X lately')?"
- "Should I use time-series analysis on tags, LLM-based summarization, or both?"
- "How do I compare topic distribution across different time periods?"
- "How do I visualize topic trends for the user?"

**Expected output document:**
`pattern_analysis_spec.md` covering:
- Tag aggregation strategies (time windows, frequency analysis)
- Topic clustering algorithms (K-means, DBSCAN, hierarchical)
- Shift detection methods (statistical tests, LLM comparison)
- Trend extraction (what's increasing, decreasing, stable)
- Visualization formats (time series charts, topic clouds, summaries)

---

### 7. Project Context Modeling

**Status**: Not Started
**Urgency**: Medium (needed for application suggester)

**Why this matters:**
Need to model project goals and challenges to match content recommendations.

**Discussion topics:**
- "How should I model project goals, tech stack, and challenges?"
- "What's the best way to represent 'current challenges' for semantic matching?"
- "Should I embed project descriptions for similarity search?"
- "How do I keep project context up-to-date automatically?"
- "Should I extract project context from git commits, code, or manual input?"

**Expected output document:**
`project_context_spec.md` covering:
- Project schema design (goals, challenges, tech stack, status, priority)
- Embedding strategy (should projects have vectors? whole project or per-goal?)
- Context freshness (how to detect stale project info)
- Automatic challenge extraction (from code, commits, issues)
- Matching strategies (project needs → relevant content)

---

### 8. Feedback Loop Design

**Status**: Not Started
**Urgency**: Medium (needed after basic recommendations work)

**Why this matters:**
System needs to learn what recommendations work best over time.

**Discussion topics:**
- "How do I design feedback loops for recommendation quality?"
- "Should I use explicit feedback (ratings) or implicit (clicks, time spent, applied suggestions)?"
- "Is reinforcement learning overkill for a personal tool?"
- "What metrics should I track (precision@k, NDCG, user satisfaction)?"
- "How do I know if a recommendation was good (user acted on it, ignored it, disliked it)?"

**Expected output document:**
`feedback_loop_spec.md` covering:
- Feedback types (explicit: ratings, thumbs up/down; implicit: clicks, dwell time)
- Metrics to track (recommendation quality, diversity, serendipity)
- Learning algorithms (simple weighted scoring vs RL vs multi-armed bandit)
- A/B testing strategies (comparing recommendation approaches)
- Offline evaluation (test with historical data)

---

## Completed Discussions

### Embedding Pipeline Architecture

**Status**: Complete
**Document**: `knowledge/specs/recommendation-engine.md`

**Key insights:**
- Use global embeddings for whole-document recommendations
- Use chunk embeddings for precise search
- Dual-collection architecture enables different retrieval modes

---

## Discussion Priority Summary

**Do these first (High urgency + High impact):**
1. Preference Learning & Recommendation Algorithms
2. Chunking Strategy for Long-Form Content
3. Application Suggester Pattern Matching

**Do these second (Foundation for advanced features):**
4. Dual-Collection Retrieval Modes
5. Project Context Modeling

**Do these later (Quality of life improvements):**
6. Content Monitoring & Auto-Ingestion
7. Cross-Content Pattern Analysis
8. Feedback Loop Design

---

## Notes

- **Time investment**: Budget 45-60 minutes per research session for best results
- **Follow-up**: Most topics need 2-3 rounds of clarification questions
- **Documentation**: Save all specs to `knowledge/specs/` for future reference
- **Integration**: Link new specs from related documents as appropriate
