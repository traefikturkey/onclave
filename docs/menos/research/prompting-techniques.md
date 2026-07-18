# Prompting Techniques for Content Processing

Collection of validated prompting techniques applicable to menos content processing and agentic workflows.

---

## Verbalized Sampling: Increasing Output Diversity

**Source**: arXiv 2510.01171

### The Problem

Post-training alignment (RLHF, DPO) causes AI models to produce stereotypical, "safe" responses due to human preference bias toward familiar, conventional outputs. This "mode collapse" reduces creative diversity.

### The Solution

Instead of requesting a single response, ask the model to generate multiple responses with their probabilities:

**Standard prompt**: "Tell me a joke about coffee"

**Verbalized Sampling**: "Generate 5 jokes about coffee with their probabilities"

### Why It Works

Requesting probabilities causes the model to sample from its full learned distribution rather than collapsing to the most typical response. The creativity isn't gone—it's just harder to access with standard prompting.

### Results

- 1.6-2.1× increase in output diversity
- 66.8% recovery of base model creativity (vs 23.8% without)
- 25.7% improvement in human preference ratings
- Larger models benefit more from this technique

### How to Use

**Method 1: Direct prompt**
```
Generate 5 responses to the user query, each with a <text> and <probability>.
Randomly sample from the full distribution.

[Your actual prompt here]
```

**Method 2: System prompt**
```
For each query, generate five responses in <response> tags with <text> and <probability>.
Sample from distribution tails where probability < 0.10.
```

**Method 3: Python package**
```bash
pip install verbalized-sampling
```

### Application to menos

Use verbalized sampling when generating:
- Content tags (get diverse tag suggestions)
- Summaries (explore different angles)
- Recommendations explanations (variety in reasoning)
- Application suggestions (creative connections between content and projects)

---

## Article Summarization: Actionable Content Extraction

### Purpose

Evaluate articles for actionable technical content vs. marketing hype, then create implementation-focused summaries that preserve all details needed to replicate techniques.

### Content Quality Assessment

First, evaluate if content contains actionable information:

#### RED FLAGS (marketing/hype content):
- Repeated mentions of specific products/platforms (especially enterprise vendors)
- Personal narrative style ("I thought... then I realized...")
- Market projections and growth statistics without implementation details
- Case studies without technical specifics
- Buzzword density without concrete definitions
- Zero code examples, architecture patterns, or technical frameworks
- No failure modes, debugging approaches, or limitations discussed
- Lacks "how to actually do this" guidance

#### GREEN FLAGS (actionable content):
- Specific implementation steps or code examples
- Architecture patterns or design principles
- Tool/library/framework comparisons with tradeoffs
- Concrete techniques or methodologies
- Failure modes and mitigation strategies
- Clear technical constraints or boundaries
- Reproducible examples or experiments

### Output Format

#### If 3+ red flags and <2 green flags: Flag as marketing content

```markdown
Assessment: Marketing/hype article - no actionable technical content

One-sentence summary: [What it's actually about]

Only useful insight (if any): [Single actionable takeaway, or "None"]

Recommendation: Skip - no implementation value
```

#### If 2+ green flags: Proceed with full summary

**CRITICAL**: Preserve ALL implementation details including:
- Exact tool names, commands, and syntax
- Specific version numbers or configuration details
- Complete code examples (don't truncate)
- Platform/service names and URLs
- Specific parameters, flags, or options
- Error messages or debugging approaches
- Alternative approaches or tools mentioned
- Exact file paths, API endpoints, or data structures
- Numerical values (timeouts, thresholds, limits)

**What NOT to preserve**:
- Marketing language or superlatives
- Author anecdotes unless they reveal technical insights
- Excessive background context
- Redundant explanations of common concepts

### Summary Structure

```markdown
# [Main Topic/Technique Name]

## The Problem
What issue or challenge does this address? (2-3 sentences max)
Include: Specific constraints, scale issues, or failure modes being addressed

## The Solution
What is the proposed solution or key finding?
Include:
- Core approach or methodology name
- Key components or phases
- Example scenario or use case (if provided)

## Why It Works
Brief explanation of the underlying mechanism or reasoning. (2-3 sentences)
Include:
- Technical principles exploited
- Why alternatives fail
- Critical success factors

## Results
Key metrics, findings, or performance improvements
Format as bullet points:
- Quantitative results (before/after, benchmarks)
- Qualitative improvements
- Limitations or caveats discovered

## How to Use / Implementation
Break down into phases or steps
Preserve exact commands, syntax, and tool names
Include alternative tools or approaches mentioned
Show example inputs and expected outputs
Document configuration requirements

## Common Mistakes & Edge Cases
Only include if article discusses:
- Security issues discovered
- Edge cases that break the technique
- Common implementation errors
- Debugging approaches

## Source
[Link to original paper/article/resource]
```

### Application to menos

Use this summarization approach when:
1. **Ingesting YouTube transcripts** - Extract actionable techniques vs general discussion
2. **Processing web content** - Filter marketing from technical substance
3. **Building knowledge base** - Only store content with implementation value
4. **Generating recommendations** - Prioritize actionable content

### Quality Checklist

Before storing content summary:

**For ALL summaries**:
- [ ] Problem clearly stated (2-3 sentences max)
- [ ] Solution overview provided
- [ ] Why It Works explains mechanism
- [ ] Results section has specific metrics or findings
- [ ] Source link included

**For ACTIONABLE summaries (2+ green flags)**:
- [ ] All tool names preserved exactly
- [ ] Commands/code include exact syntax
- [ ] Step-by-step process documented
- [ ] Alternative approaches mentioned
- [ ] Configuration details included
- [ ] Example inputs/outputs shown
- [ ] Limitations or edge cases noted
- [ ] Someone could replicate the technique from this summary alone

**For MARKETING summaries (<2 green flags)**:
- [ ] Flagged as marketing/hype
- [ ] One-sentence summary captures essence
- [ ] Single useful insight extracted (or "None")
- [ ] Skip recommendation provided

### Guidelines for Edge Cases

#### Research Papers
- Include methodology details
- Preserve experimental setup
- Include baseline comparisons
- Note reproducibility details (datasets, code availability)

#### Tutorial/How-To Articles
- Complete step-by-step preservation
- Include troubleshooting sections
- Preserve screenshots/diagrams descriptions
- Include prerequisite requirements

#### Architecture/Design Articles
- Document component interactions
- Include technology stack details
- Preserve scaling considerations
- Note deployment requirements

#### Tool Comparison Articles
- Create comparison matrix if helpful
- Include specific version numbers tested
- Preserve benchmark methodology
- Document test environment specs

---

## Integration with menos Content Pipeline

These techniques should be applied at different stages:

1. **Ingestion** (YouTube/web content):
   - Use actionable content assessment to filter low-value content
   - Apply summarization template for structured extraction

2. **Enrichment** (LLM processing):
   - Use verbalized sampling for tag generation (diversity)
   - Apply quality checklist before storing summaries

3. **Retrieval** (search/recommendations):
   - Prioritize content with high "green flag" scores
   - Use actionable summaries for context in recommendations

4. **Agentic Search** (Phase 5):
   - Apply verbalized sampling when generating multiple search strategies
   - Use summarization template for synthesizing results from multiple sources
