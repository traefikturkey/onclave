# Recursive Language Models: Academic Foundation for Agentic Search

**Paper**: Zhang, Kraska, Khattab (MIT CSAIL) - December 2025
**arXiv**: 2512.24601

This research provides academic validation for the agentic search architecture planned for menos Phase 5.

---

## Core Insight

Long prompts should NOT be fed directly into the neural network. Instead, treat them as **part of the external environment** that the LLM can symbolically interact with.

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│                    RLM (root / depth=0)                     │
├─────────────────────────────────────────────────────────────┤
│  Environment E (Python REPL)                                │
│  ├── context = "<very long document>"   # NOT in LLM ctx   │
│  ├── llm_query(prompt) → str            # recursive calls  │
│  └── print() → observe results                              │
│                                                             │
│  Model writes code to:                                      │
│  1. Peek at context (print(context[:1000]))                │
│  2. Decompose (chunks = context.split('\n'))               │
│  3. Filter (regex, keyword search)                         │
│  4. Recursively invoke self on chunks                      │
│  5. Store results in variables                             │
│  6. Return FINAL(answer) or FINAL_VAR(variable)            │
└─────────────────────────────────────────────────────────────┘
```

## Key Implementation Details

### REPL Environment
- Context loaded as string variable (not in LLM context window)
- `llm_query(prompt)` function available for recursive sub-calls
- Variables persist across code executions
- `print()` outputs truncated results back to root LLM

### Model Hierarchy
- **Root LM** (e.g., Claude Sonnet): Orchestrates, sees metadata only
- **Sub-LM** (e.g., Claude Haiku): Handles ~500K character chunks
- Max recursion depth = 1 in experiments (sub-calls are plain LMs, not RLMs)

### Termination
- `FINAL(answer)` - return answer directly
- `FINAL_VAR(variable_name)` - return variable from REPL as output

## Results

### Performance (Table 1)

| Task | Base Model | RLM | Improvement |
|------|------------|-----|-------------|
| CodeQA (23K-4.2M tokens) | 24%* | 62% | +158% |
| BrowseComp+ (6-11M tokens) | 0%* | 91.33% | N/A (can't fit) |
| OOLONG (131K tokens) | 44% | 56.50% | +28% |
| OOLONG-Pairs (32K tokens) | 0.04% | 58.00% | +144,900% |

*asterisk = ran into context limits

### Cost Analysis
- **Median RLM cost ≤ base model cost** (often cheaper due to selective viewing)
- **High variance** - some trajectories 3x more expensive due to long explorations
- At 10M+ tokens: RLM costs ~$0.99/query vs theoretical $1.50-$2.75 for full context

### Scaling Behavior
- Base models degrade quickly as context grows (context rot)
- RLMs maintain performance up to 1M+ tokens
- More complex tasks (quadratic vs linear) show larger RLM advantage

## Emergent Patterns Observed

### 1. Code-Based Filtering Without Seeing Content
```python
# Model uses priors to search for relevant sections
keywords = ["machine learning", "neural network", "transformer"]
results = {kw: find_snippets(kw, window=400) for kw in keywords}
```

### 2. Chunking and Recursive Sub-Calling
```python
# Uniform chunking for semantic transformation
for i in range(0, len(lines), batch_size):
    batch = lines[i:i+batch_size]
    classification = llm_query(f"Classify: {batch}")
    results.append(classification)
```

### 3. Answer Verification via Sub-Calls
```python
# Use sub-LM to verify answer in fresh context (avoids context rot)
confirm = llm_query(f"Verify this answer: {answer}\nEvidence: {chunk}")
```

### 4. Variable Storage for Long Outputs
```python
# Build answer incrementally in variables
for pair in pairs:
    result = llm_query(f"Process: {pair}")
    formatted_pairs.append(result)
FINAL_VAR(formatted_pairs)  # Return variable, not string
```

---

## Application to menos Phase 5

### Architecture Alignment

| RLM Paper | menos Agentic Search | Notes |
|-----------|---------------------|-------|
| Python REPL environment | FastAPI + SurrealDB state | Similar pattern |
| `context` variable (external to LLM) | Content in SurrealDB/MinIO | Same pattern |
| `llm_query(prompt)` function | Tool-less sub-agents | Same pattern |
| `print()` to observe results | API response capture | Same pattern |
| `FINAL(answer)` termination | Task completion signal | Adopt this |
| Root LM + Sub-LM hierarchy | Orchestrator + specialist agents | Same pattern |

**Key insight**: menos's planned architecture independently arrived at the same pattern. The paper validates this approach and provides benchmarks showing it works at scale (10M+ tokens).

### Concrete Implementation Ideas

#### 1. Adopt FINAL/FINAL_VAR Termination Pattern

Add explicit termination signals to orchestrator:
```python
# In orchestrator system prompt
"""
When you have the final answer:
- FINAL(answer) - return simple text answer
- FINAL_VAR(variable_name) - return complex data from working memory

This signals task completion and prevents unnecessary extra steps.
"""
```

**Benefit**: Cleaner task boundaries, prevents over-iteration.

#### 2. Model Hierarchy for Cost Optimization

```
Orchestrator (Claude Sonnet)
├── Content Processor (Haiku) - transcript/metadata processing
├── Search Agent (Haiku) - vector search operations
├── Embedding Agent (local Ollama) - vector generation
└── Synthesis Agent (Sonnet) - complex reasoning
```

**Cost implications**:
- Route 90% of work to Haiku ($0.25/1M vs $3/1M for Sonnet)
- Reserve Sonnet for orchestration decisions and final synthesis
- Paper shows median RLM cost ≤ base model cost despite extra calls

#### 3. Code-Based Filtering Before Expensive Operations

```python
# Orchestrator filters content without loading full transcripts
def find_relevant_content(query: str) -> list[str]:
    # Use metadata search first (SurrealDB query)
    candidates = search_by_tags_and_title(query)  # Fast, no embeddings

    # Only load transcripts for top candidates
    if len(candidates) > 50:
        # Let LLM generate search terms from query
        search_terms = llm_query(f"Generate 5 search keywords for: {query}")
        candidates = filter_by_transcript_keywords(candidates, search_terms)

    return candidates[:20]  # Return top 20 for detailed analysis
```

**Benefit**: Massive cost reduction for large archive queries.

#### 4. Answer Verification Pattern

After finding candidate answer, verify with fresh sub-LM call:
```python
answer = "The technique is called attention masking"
evidence = relevant_chunk[:5000]

# Verify with fresh sub-LM call (no accumulated context rot)
verification = llm_query(f"""
Verify this answer is correct:
Answer: {answer}
Evidence: {evidence}
Respond: CORRECT or INCORRECT with explanation
""")
```

**Use for**: High-stakes queries, recommendation synthesis, multi-source aggregation.

### What We Can Skip

The paper also shows what **doesn't** help:

1. **Deep recursion** (depth > 1): Paper only tested depth=1, no evidence deeper helps
2. **Async parallelism**: Paper notes this as future work, not implemented
3. **Training for RLM**: Paper uses off-the-shelf models, no fine-tuning needed

### Recommended Implementation Order

1. **Add FINAL/FINAL_VAR termination** to orchestrator system prompt
2. **Implement keyword pre-filtering** for content queries
3. **Add verification step** for synthesis queries
4. **Test model hierarchy** (Haiku for chunks, Sonnet for orchestration)
5. **Measure cost vs accuracy** on real queries

### Key Metrics to Track

- **Tokens processed per query** (target: handle 10M+ capability)
- **Cost per query** (target: ≤ base model cost)
- **Accuracy on information-dense tasks** (target: 50%+ improvement)
- **Sub-call count per query** (watch for runaway recursion)

## Comparison to Alternatives

| Method | Can Scale Beyond Context? | Performance | Cost |
|--------|---------------------------|-------------|------|
| Base LLM | No | Degrades with length | Baseline |
| Summary Agent | Yes (lossy) | Loses fine-grained info | High |
| CodeAct + BM25 | Somewhat | Good for retrieval tasks | Medium |
| **RLM** | **Yes (100x)** | **Best on dense tasks** | **Comparable** |

## Limitations & Future Work

1. **Synchronous sub-calls are slow** - async would significantly reduce runtime
2. **No deep recursion tested** - only depth=1 (sub-calls are LMs, not RLMs)
3. **Model-dependent behavior** - some models make 1000s of sub-calls where others make 10
4. **Not trained for RLM** - current models are "inefficient decision makers over their context"
5. **High variance** - some trajectories explode in cost due to redundant verification

## Key Takeaways

1. **Separation of concerns**: Symbolic manipulation (code) vs semantic reasoning (LLM calls)
2. **Context as environment**: Data stays outside neural network until explicitly examined
3. **Recursive decomposition**: Break problems into sub-problems, delegate to sub-LMs
4. **Variable persistence**: Working memory bridges multiple reasoning steps
5. **Model priors help**: LLMs can filter context without seeing it (keyword search, regex)

---

**Related Work Cited**:
- Claude Code subagents (Anthropic, 2025)
- MemGPT (Packer et al., 2024)
- THREAD recursive spawning (Schroeder et al., 2025)
- Context Folding (Sun et al., 2025)
- ReSum summarization (Wu et al., 2025)

**Integration with menos**: This pattern aligns with tool-less sub-agent architecture required to avoid nested agent deadlocks - see `knowledge/lessons/nested-agent-deadlock.md`.
